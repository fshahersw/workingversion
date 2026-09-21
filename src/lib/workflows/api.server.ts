import { z } from "zod";
import { getUserFromRequest } from "../auth/cognito.server";
import {
  idSchema,
  revisionSchema,
  inputsSchema,
  assertSameOrigin,
  WorkflowError,
  type Principal,
} from "./policy";
import * as store from "./repository.server";

const operation = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("save"),
    id: idSchema,
    revision: revisionSchema,
    flow: z.unknown(),
  }),
  z.object({
    action: z.enum(["publish", "share", "schedule", "delete"]),
    id: idSchema,
    revision: revisionSchema,
    value: z.unknown().optional(),
  }),
  z.object({
    action: z.literal("start"),
    id: idSchema,
    requestId: idSchema,
    inputs: inputsSchema,
    published: z.boolean(),
  }),
  z.object({ action: z.literal("cancel"), id: idSchema }),
  z.object({
    action: z.literal("review"),
    id: idSchema,
    approved: z.boolean(),
    notes: z.string().max(10000),
  }),
]);
async function readBody(request: Request) {
  const max = 5_500_000;
  if (Number(request.headers.get("content-length")) > max)
    throw new WorkflowError(413, "Request exceeds the 5.5 MB limit.");
  const reader = request.body?.getReader();
  if (!reader) throw new WorkflowError(400, "Request body required.");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > max) {
        await reader.cancel();
        throw new WorkflowError(413, "Request exceeds the 5.5 MB limit.");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"), (key, value) => {
      if (["__proto__", "constructor", "prototype"].includes(key))
        throw new Error("Invalid property.");
      return value;
    });
  } catch {
    throw new WorkflowError(400, "Invalid JSON request.");
  }
}
const json = (value: unknown, status = 200) =>
  Response.json(value, { status, headers: { "Cache-Control": "no-store", Vary: "Cookie" } });
export async function workflowApi(request: Request) {
  try {
    const session = await getUserFromRequest(request);
    if (!session) return json({ error: "Sign in to access Workflows." }, 401);
    const user: Principal = {
      sub: session.sub,
      email: session.emailVerified === true ? session.email : "",
      name: session.name,
      groups: session.groups,
    };
    const url = new URL(request.url);
    if (request.method === "GET" && url.searchParams.get("view") === "capabilities")
      return json({
        enabled: store.configured(),
        queue: store.queueEnabled(),
        scheduler: process.env.SW_WORKFLOWS_SCHEDULER_ENABLED === "true",
        python: Boolean(process.env.SW_WORKFLOWS_PYTHON_INTERPRETER_ID),
        groups: user.groups,
        note: "Service availability is configuration-based. Individual executions still require valid permissions and a healthy provider.",
      });
    store.requireConfigured();
    if (request.method === "GET") {
      const view = url.searchParams.get("view");
      if (view === "run") {
        const { run } = await store.loadRun(user, idSchema.parse(url.searchParams.get("id")));
        return json(run);
      }
      if (view === "runs") return json(await store.listRuns(user));
      if (view === "sources") {
        const { listWorkspaces } = await import("../kb/workspace.server");
        return json(await listWorkspaces(user.sub));
      }
      if (view === "source") {
        const itemId = z.string().min(1).max(128).parse(url.searchParams.get("id"));
        const { getWorkspace, getWorkspacePages } = await import("../kb/workspace.server");
        const workspace = await getWorkspace(user.sub, itemId);
        if (!workspace) throw new WorkflowError(404, "Workspace not found.");
        if (workspace.status !== "ready")
          throw new WorkflowError(
            409,
            "This workspace is still processing. Wait for ingestion to complete.",
          );
        if (workspace.docs.length > 20)
          throw new WorkflowError(413, "Choose a workspace containing at most 20 documents.");
        const files = [];
        for (const d of workspace.docs) {
          const pages = await getWorkspacePages(user.sub, itemId, d.docId);
          if (pages.length !== d.pageCount)
            throw new WorkflowError(
              422,
              "The saved page count does not match the source manifest. Reprocess the document before using it.",
            );
          const text = pages.map((p) => `[Page ${p.page}]\n${p.text}`).join("\n");
          const warnings = pages
            .filter((p) => !p.text.trim())
            .map((p) => `Page ${p.page} has no extracted text. Review the original or run OCR.`);
          files.push({
            id: d.docId,
            name: d.fileName,
            text,
            size: Buffer.byteLength(text),
            metadata: {
              format: "workspace",
              warnings,
              pages: pages.length,
              extractedAt: new Date().toISOString(),
            },
          });
        }
        inputsSchema.parse({ text: "", matter: "", selection: "", files });
        return json(files);
      }
      if (view === "skill") {
        // Firm skill preset instructions live server-side (skills-instructions.server);
        // the Builder inspector fetches one to prefill a prompt/agent step.
        const id = z
          .string()
          .min(1)
          .max(80)
          .regex(/^[a-z0-9-]+$/)
          .parse(url.searchParams.get("id"));
        const { skillInstructions } = await import("./skills-instructions.server");
        const instructions = skillInstructions(id);
        if (!instructions) throw new WorkflowError(404, "Unknown skill preset.");
        return json({ id, instructions });
      }
      return json(await store.listDefinitions(user));
    }
    assertSameOrigin(
      request,
      process.env.COGNITO_REDIRECT_URI
        ? new URL(process.env.COGNITO_REDIRECT_URI).origin
        : undefined,
    );
    const body = operation.parse(await readBody(request));
    if (body.action === "save")
      return json(await store.saveDefinition(user, body.id, body.flow, body.revision));
    if (body.action === "start")
      return json(
        await store.startRun(user, body.id, body.inputs, body.published, body.requestId),
        202,
      );
    if (body.action === "cancel") return json(await store.actOnRun(user, body.id, "cancel"));
    if (body.action === "review")
      return json(await store.actOnRun(user, body.id, "review", body.approved, body.notes));
    return json(
      await store.changeDefinition(user, body.id, body.revision, body.action, body.value),
    );
  } catch (error) {
    if (error instanceof WorkflowError) return json({ error: error.message }, error.status);
    if (error instanceof z.ZodError)
      return json(
        {
          error:
            "Invalid workflow request: " +
            error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
        },
        400,
      );
    const reference = crypto.randomUUID();
    console.error("Workflow request failed", {
      reference,
      errorType: error instanceof Error ? error.name : "Unknown",
    });
    return json(
      { error: `The workflow service could not complete this request. Reference: ${reference}` },
      500,
    );
  }
}
