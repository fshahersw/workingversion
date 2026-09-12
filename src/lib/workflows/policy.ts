import { z } from "zod";
import { importWorkflow, validateWorkflow } from "./graph.ts";
import type { RunInputs, Workflow, WorkflowRun } from "./types";

export class WorkflowError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}
export type Principal = { sub: string; email: string; name?: string; groups: string[] };
export type Access = { owner: string; sharing: Workflow["sharing"]; deleted?: boolean };
export const idSchema = z.string().uuid();
export const revisionSchema = z.number().int().nonnegative();
const safeKey = z
  .string()
  .min(1)
  .max(100)
  .refine((v) => !["__proto__", "constructor", "prototype"].includes(v));
const fileSchema = z.object({
  id: safeKey,
  name: z.string().min(1).max(250),
  text: z
    .string()
    .min(1)
    .max(500_000)
    .refine((s) => !!s.trim(), "The source has no readable text."),
  size: z
    .number()
    .int()
    .min(0)
    .max(20 * 1024 * 1024),
  metadata: z
    .object({
      format: z.string().max(30),
      sha256: z
        .string()
        .regex(/^[a-f0-9]{64}$/)
        .optional(),
      warnings: z.array(z.string().max(2000)).max(100),
      pages: z.number().int().min(0).max(300).optional(),
      extractedAt: z.string().max(40),
    })
    .optional(),
});
export const inputsSchema = z
  .object({
    text: z.string().max(1_000_000),
    matter: z.string().max(250),
    selection: z.string().max(250),
    files: z.array(fileSchema).max(20),
    fields: z.record(safeKey, z.string().max(20_000)).optional(),
  })
  .superRefine((v, c) => {
    if (v.text.length + v.files.reduce((n, f) => n + f.text.length, 0) > 1_000_000)
      c.addIssue({
        code: "custom",
        message:
          "Split this run into named batches of at most 1,000,000 characters; no source was truncated.",
      });
    if (new Set(v.files.map((f) => f.id)).size !== v.files.length)
      c.addIssue({ code: "custom", message: "Source identifiers must be unique." });
  });
export function permission(
  user: Principal,
  item: Access,
): "owner" | "edit" | "run" | "view" | undefined {
  if (item.deleted) return;
  if (item.owner === user.sub) return "owner";
  if (
    item.sharing.visibility === "teams" &&
    item.sharing.teams.some((g) => user.groups.includes(g))
  )
    return item.sharing.permission;
}
export function authorize(
  user: Principal,
  item: Access,
  action: "view" | "run" | "edit" | "owner" = "view",
) {
  const rank = { view: 1, run: 2, edit: 3, owner: 4 };
  const granted = permission(user, item);
  if (!granted || rank[granted] < rank[action])
    throw new WorkflowError(403, "You do not have access to this workflow action.");
}
export function validateSharing(value: unknown, user: Principal): Workflow["sharing"] {
  const sharing = z
    .object({
      visibility: z.enum(["private", "teams"]),
      teams: z.array(z.string().min(1).max(128)).max(30),
      permission: z.enum(["view", "run", "edit"]),
    })
    .parse(value);
  sharing.teams = [...new Set(sharing.teams)];
  if (sharing.visibility === "private") sharing.teams = [];
  if (
    sharing.visibility === "teams" &&
    (!sharing.teams.length || sharing.teams.some((g) => !user.groups.includes(g)))
  )
    throw new WorkflowError(400, "Select one or more of your authenticated Cognito groups.");
  return sharing;
}
export function parseDefinition(value: unknown): Workflow {
  try {
    return importWorkflow(JSON.stringify(value));
  } catch (e) {
    throw new WorkflowError(400, e instanceof Error ? e.message : "Invalid workflow.");
  }
}
export function assertRunnable(flow: Workflow, inputs?: RunInputs) {
  const errors = validateWorkflow(flow).filter((i) => i.severity === "error");
  if (errors.length) throw new WorkflowError(400, errors.map((e) => e.message).join(" "));
  for (const n of flow.nodes) {
    if (
      n.data.kind === "delay" &&
      (!Number.isFinite(n.data.config.seconds) ||
        n.data.config.seconds! < 1 ||
        n.data.config.seconds! > 30 * 86400)
    )
      throw new WorkflowError(400, "Wait steps must be between one second and 30 days.");
    if (
      n.data.kind === "review" &&
      n.data.config.reviewer &&
      n.data.config.reviewer !== "owner" &&
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(n.data.config.reviewer)
    )
      throw new WorkflowError(
        400,
        "A review must name the workflow owner or an exact reviewer email address.",
      );
  }
  if (
    inputs?.files.some((f) => f.metadata?.warnings.length) &&
    inputs.fields?.coverageAcknowledged !== "true"
  )
    throw new WorkflowError(
      400,
      "Review and acknowledge source extraction warnings before starting this run.",
    );
  if (
    inputs &&
    !inputs.text.trim() &&
    !inputs.files.length &&
    flow.nodes.some((n) =>
      ["recipe", "extract", "compare", "table", "citations", "edit"].includes(n.data.kind),
    ) &&
    !flow.nodes.some((n) => ["web", "scrape", "search", "mcp"].includes(n.data.kind))
  )
    throw new WorkflowError(400, "Supply readable source material for this document workflow.");
  if (
    inputs &&
    flow.nodes.some(
      (n) => n.data.kind === "selection" && !n.data.config.options?.includes(inputs.selection),
    )
  )
    throw new WorkflowError(400, "Choose a valid workflow selection before running.");
  if (inputs)
    for (const field of flow.app?.fields || []) {
      const value = inputs.fields?.[field.id] || "";
      if (field.required && !value.trim())
        throw new WorkflowError(400, "Enter " + field.label + ".");
      if (field.type === "select" && value && !field.options?.includes(value))
        throw new WorkflowError(400, "Invalid choice for " + field.label + ".");
    }
}
export function canReview(user: Principal, owner: string, run: WorkflowRun): boolean {
  const node = run.graph.nodes.find(
    (n) => n.data.kind === "review" && run.results[n.id]?.status === "waiting",
  );
  if (!node || run.status !== "waiting") return false;
  const reviewer = node.data.config.reviewer;
  return !reviewer || reviewer === "owner"
    ? user.sub === owner
    : reviewer.toLowerCase() === user.email.toLowerCase();
}
/** Run inputs are private to the submitter, owner and explicitly assigned reviewers.
 * Merely sharing the template never gives teammates access to another user's documents. */
export function canReadRun(user: Principal, owner: string, submitter: string, reviewers: string[]) {
  return (
    user.sub === owner ||
    user.sub === submitter ||
    reviewers.some((e) => e.toLowerCase() === user.email.toLowerCase())
  );
}
export function assertSameOrigin(request: Request, expectedOrigin = new URL(request.url).origin) {
  const origin = request.headers.get("origin");
  const fetchSite = request.headers.get("sec-fetch-site");
  if (
    !origin ||
    origin !== expectedOrigin ||
    (fetchSite && !["same-origin", "none"].includes(fetchSite))
  )
    throw new WorkflowError(403, "A same-origin request is required.");
  if (!request.headers.get("content-type")?.startsWith("application/json"))
    throw new WorkflowError(415, "Use application/json.");
}
