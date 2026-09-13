import { z } from "zod";
import { catalog } from "./catalog.ts";
import { exportWorkflow, importWorkflow, tidyLayout, validateWorkflow } from "./graph.ts";
import { recipeNames } from "./recipes.ts";
import { WORKFLOW_TOOLS, approvedToolNames, buildToolArgs } from "./tool-contracts.ts";
import type { StepConfig, StepKind, Workflow, WorkflowEdge, WorkflowStep } from "./types";

/**
 * The plan intermediate representation a workflow generator emits, its validator,
 * and the materializer that turns an accepted plan into a real Workflow.
 *
 * Three constraints shape everything here.
 *
 * 1. A generator must never author node identifiers, canvas positions or
 *    `data.output`. Those are the most common source of validateWorkflow errors
 *    and are all mechanically derivable, so steps reference each other by a short
 *    `key` and this module derives the rest.
 *
 * 2. `importWorkflow` (graph.ts) is the server admission gate, and it copies node
 *    data verbatim (`data: n.data`) after checking only the keys it knows about.
 *    An unrecognized setting such as `timeoutSeconds` would therefore be stored,
 *    shown in the Builder as if it were configured, and do nothing at run time.
 *    So every settings member is `.strict()` and `materialize` builds each
 *    StepConfig field by field. Nothing model-supplied is ever spread into a
 *    StepConfig.
 *
 * 3. Validation must not pass anything the run-time adapter will reject. The
 *    (kind, connection, tool) rules in adapter.server.ts and the tool argument
 *    contracts in tool-contracts.ts are re-checked here so a plan cannot be
 *    accepted, materialized, saved and then fail on first run.
 *
 * Structural authority stays with `validateWorkflow`; this module runs it on the
 * materialized graph rather than reimplementing it.
 */

/** Keys are short so a generator can reference them reliably; also a valid `data.output`. */
const KEY = /^[a-z][a-z0-9_]{0,23}$/;
/** Same shape policy.ts uses for a reviewer address. */
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
/** A condition reads `key` or `key.field`; validateWorkflow resolves the part before the first dot. */
const REFERENCE = /^[a-z][a-z0-9_]{0,23}(\.[A-Za-z0-9_]{1,40}){0,3}$/;
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

const MIN_STEPS = 2;
const MAX_STEPS = 14;
/** More than four upstream outputs in one instruction stops being reviewable. */
const MAX_CONTEXT = 4;
const DELAY_MIN = 1;
const DELAY_MAX = 2_592_000;
/** adapter.server.ts:48 — 100 model requests per step, 200 per run. */
const STEP_REQUESTS = 100;
const RUN_REQUESTS = 200;
/** The firm's operating zone; importWorkflow requires a resolvable IANA zone. */
const TIMEZONE = "America/New_York";
const OPERATORS = ["contains", "equals", "is_true", "greater_than", "exists"] as const;
const FORMATS = ["docx", "pdf", "txt", "csv"] as const;

const line = (max: number) => z.string().min(1).max(max);
const words = (items: number, each: number) =>
  z.array(z.string().min(1).max(each)).min(1).max(items);
/** Kinds the engine reads nothing from. A generator that sends anything here is guessing. */
const nothing = z.object({}).strict();

/**
 * One member per generatable step kind, holding only the StepConfig keys the
 * engine actually reads for that kind (engine.ts executeLocalStep,
 * adapter.server.ts, and the Builder's own inspector).
 *
 * Deliberately absent:
 * - `model` on prompt and agent. The materializer fixes it to "bedrock"; letting
 *   a generator choose it would let it silently select a path the host cannot run.
 * - `connection` on search and mcp. It is derived from the source and from the
 *   tool's declared connector, which is the only combination the adapter accepts.
 * - `value` on a workspace search. That is a saved workspace identifier no
 *   generator can know, so the step is reported as needing user input instead.
 * - `code` on python. python is not generatable at all; see PLAN_UNSUPPORTED.
 */
const SETTINGS = {
  trigger: nothing,
  files: nothing,
  compare: nothing,
  /** The adapter forces verify_citations and supplies the text from the run's own sources. */
  citations: nothing,
  foreach: nothing,
  merge: nothing,
  response: nothing,
  text: z.object({ value: z.string().max(20_000).optional() }).strict(),
  selection: z.object({ options: words(30, 200) }).strict(),
  prompt: z
    .object({
      instructions: line(8000),
      context: z.array(z.string().min(1).max(24)).max(MAX_CONTEXT).optional(),
    })
    .strict(),
  agent: z
    .object({
      instructions: line(8000),
      context: z.array(z.string().min(1).max(24)).max(MAX_CONTEXT).optional(),
    })
    .strict(),
  extract: z.object({ fields: words(40, 80) }).strict(),
  table: z.object({ fields: words(20, 80) }).strict(),
  search: z
    .object({
      source: z.enum(["workspace", "docketbird"]),
      query: line(2000),
      tool: z.string().min(1).max(60).optional(),
    })
    .strict(),
  condition: z
    .object({
      left: line(120),
      operator: z.enum(OPERATORS),
      right: z.string().max(2000).optional(),
    })
    .strict(),
  review: z.object({ reviewer: line(200), instructions: line(4000) }).strict(),
  delay: z.object({ seconds: z.number().int() }).strict(),
  document: z
    .object({ filename: line(80), format: z.enum(FORMATS), instructions: line(4000) })
    .strict(),
  /** StepConfig calls these left and right; the plan names them for what they mean. */
  edit: z
    .object({
      find: line(2000),
      replace: z.string().max(2000),
      instructions: line(4000).optional(),
    })
    .strict(),
  notify: z
    .object({
      recipients: z.array(z.string().min(1).max(200)).max(10),
      instructions: line(4000),
    })
    .strict(),
  mcp: z
    .object({ tool: z.string().min(1).max(60), args: z.record(z.string(), z.unknown()) })
    .strict(),
  recipe: z
    .object({
      recipe: z.string().min(1).max(40),
      instructions: line(4000).optional(),
      fields: words(20, 80).optional(),
    })
    .strict(),
  web: z.object({ tool: z.string().min(1).max(60), query: line(2000) }).strict(),
  scrape: z.object({ url: line(2000) }).strict(),
  // A new StepKind in types.ts breaks the build here until it is either given a
  // member or added to PLAN_UNSUPPORTED, so the vocabulary cannot drift.
} satisfies Record<Exclude<StepKind, "python">, z.ZodTypeAny>;

/**
 * python is refused by design. A generated Python step is arbitrary sandbox code
 * that a reviewer cannot judge from a workflow diagram, and unlike every other
 * kind its behaviour is not bounded by the step's settings.
 */
export const PLAN_UNSUPPORTED: readonly StepKind[] = ["python"];

type PlanKind = keyof typeof SETTINGS;

/**
 * The discriminated form, for generating a model-facing schema. The authored form
 * omits the discriminator because the step already carries `kind`; carrying it
 * twice only creates a way for the two to disagree.
 */
export const planSettingsSchema = z.discriminatedUnion("kind", [
  SETTINGS.trigger.extend({ kind: z.literal("trigger") }),
  SETTINGS.files.extend({ kind: z.literal("files") }),
  SETTINGS.compare.extend({ kind: z.literal("compare") }),
  SETTINGS.citations.extend({ kind: z.literal("citations") }),
  SETTINGS.foreach.extend({ kind: z.literal("foreach") }),
  SETTINGS.merge.extend({ kind: z.literal("merge") }),
  SETTINGS.response.extend({ kind: z.literal("response") }),
  SETTINGS.text.extend({ kind: z.literal("text") }),
  SETTINGS.selection.extend({ kind: z.literal("selection") }),
  SETTINGS.prompt.extend({ kind: z.literal("prompt") }),
  SETTINGS.agent.extend({ kind: z.literal("agent") }),
  SETTINGS.extract.extend({ kind: z.literal("extract") }),
  SETTINGS.table.extend({ kind: z.literal("table") }),
  SETTINGS.search.extend({ kind: z.literal("search") }),
  SETTINGS.condition.extend({ kind: z.literal("condition") }),
  SETTINGS.review.extend({ kind: z.literal("review") }),
  SETTINGS.delay.extend({ kind: z.literal("delay") }),
  SETTINGS.document.extend({ kind: z.literal("document") }),
  SETTINGS.edit.extend({ kind: z.literal("edit") }),
  SETTINGS.notify.extend({ kind: z.literal("notify") }),
  SETTINGS.mcp.extend({ kind: z.literal("mcp") }),
  SETTINGS.recipe.extend({ kind: z.literal("recipe") }),
  SETTINGS.web.extend({ kind: z.literal("web") }),
  SETTINGS.scrape.extend({ kind: z.literal("scrape") }),
]);

type Members = { [K in PlanKind]: z.infer<(typeof SETTINGS)[K]> }[PlanKind];
type Flatten<U> = (U extends unknown ? (value: U) => void : never) extends (value: infer I) => void
  ? I
  : never;
/**
 * Authored settings, flattened to one optional bag. The per-kind schema is the
 * real authority at run time; a flat static type keeps the materializer free of
 * casts while it reads only the keys its own case owns.
 */
export type PlanSettings = Partial<Flatten<Members>>;

export type PlanStep = {
  /** Unique in the plan; becomes `data.output`, which is how later steps read it. */
  key: string;
  kind: StepKind;
  label: string;
  /** Predecessor keys. Empty only for the trigger. */
  after: string[];
  /** Which branch of a condition predecessor this step is on. */
  branch?: "true" | "false";
  settings: PlanSettings;
  /** Shown to the person approving the plan. */
  rationale: string;
  /** Feeds a later run estimator. Never written into StepConfig. */
  budget: { modelRequests: number; seconds: number };
};

export type WorkflowPlan = {
  name: string;
  description: string;
  category: string;
  steps: PlanStep[];
  /** Materializing always leaves a schedule switched off; see materialize. */
  schedule?: { frequency: "daily" | "weekly"; time: string; days: number[] };
  assumptions: string[];
};

const budgetSchema = z
  .object({
    modelRequests: z.number().int().min(0).max(10_000),
    seconds: z.number().int().min(0).max(86_400),
  })
  .strict();

/**
 * `kind` is a plain string and `settings` is unvalidated here on purpose: an
 * unknown kind has to survive the shape gate so the vocabulary gate can name it,
 * instead of failing as an unreadable schema error. Settings are parsed against
 * the member for the step's kind immediately afterwards.
 */
const stepSchema = z
  .object({
    key: z.string().regex(KEY),
    kind: z.string().min(1).max(40),
    label: z.string().min(1).max(60),
    after: z.array(z.string().min(1).max(24)).max(8),
    branch: z.enum(["true", "false"]).optional(),
    settings: z.unknown(),
    rationale: z.string().min(1).max(200),
    budget: budgetSchema,
  })
  .strict();

export const planSchema = z
  .object({
    name: z.string().min(1).max(100),
    description: z.string().min(1).max(3000),
    category: z.string().min(1).max(60),
    steps: z.array(stepSchema).min(MIN_STEPS).max(MAX_STEPS),
    schedule: z
      .object({
        frequency: z.enum(["daily", "weekly"]),
        time: z.string().regex(TIME),
        days: z.array(z.number().int().min(0).max(6)).max(7),
      })
      .strict()
      .optional(),
    assumptions: z.array(z.string().min(1).max(300)).max(6),
  })
  .strict();

export type PlanDefectCode =
  // Shape.
  | "invalid_plan_shape"
  | "unknown_plan_field"
  | "unknown_step_field"
  | "invalid_key"
  | "invalid_label"
  | "missing_settings"
  | "invalid_setting"
  | "unknown_setting"
  // Vocabulary.
  | "duplicate_key"
  | "unknown_step_kind"
  | "python_not_generatable"
  | "unknown_tool"
  | "unknown_recipe"
  | "unknown_after"
  | "unknown_context_key"
  // Semantics.
  | "missing_trigger"
  | "multiple_triggers"
  | "trigger_has_predecessor"
  | "missing_response"
  | "cycle"
  | "unreachable_step"
  | "condition_missing_branch"
  | "condition_extra_branch"
  | "branch_required"
  | "branch_without_condition"
  | "multiple_condition_predecessors"
  | "context_not_upstream"
  | "condition_left_not_upstream"
  | "condition_right_required"
  | "delay_out_of_range"
  | "invalid_reviewer"
  | "invalid_recipient"
  | "invalid_url"
  | "schedule_needs_weekday"
  | "step_request_budget_exceeded"
  | "plan_request_budget_exceeded"
  // Tool contracts, mirrored from adapter.server.ts.
  | "tool_args_invalid"
  | "tool_requires_docketbird_connection"
  | "docketbird_connection_needs_docket_tool"
  | "tool_not_used_here"
  // Graph and admission.
  | "graph_error"
  | "admission_failed";

export type PlanDefect = {
  code: PlanDefectCode;
  /** The offending step's key, when the defect belongs to one step. */
  step?: string;
  /** Written for the person reviewing the plan, not for a developer. */
  message: string;
};

export type PlanWarning = { step?: string; message: string };

/** Something only the person running the workflow can supply. */
export type PlanInputRequest = {
  step: string;
  need: "workspace" | "recipients";
  message: string;
};

export type MaterializedPlan = { workflow: Workflow; needsInput: PlanInputRequest[] };

export type PlanReview = {
  defects: PlanDefect[];
  /** Never repaired automatically: a warning is a judgement call for a person. */
  warnings: PlanWarning[];
  needsInput: PlanInputRequest[];
  /** Present only when every gate passed. */
  workflow?: Workflow;
};

export type PlanVocabulary = {
  kinds: readonly string[];
  tools: readonly string[];
  recipes: readonly string[];
};

/** Derived from the modules that own each vocabulary, so it cannot drift from them. */
export function planVocabulary(): PlanVocabulary {
  return {
    kinds: catalog.map((item) => item.kind),
    tools: approvedToolNames(),
    recipes: Object.keys(recipeNames),
  };
}

const named = (key: string, index: number) => (key ? `the “${key}” step` : `step ${index + 1}`);
const settingsSchemaFor = (kind: string): z.ZodTypeAny | undefined =>
  Object.hasOwn(SETTINGS, kind) ? (SETTINGS as Record<string, z.ZodTypeAny>)[kind] : undefined;

function rawStepKeys(plan: unknown): string[] {
  const steps = (plan as { steps?: unknown } | null | undefined)?.steps;
  if (!Array.isArray(steps)) return [];
  return steps.map((step) => {
    const key = (step as { key?: unknown } | null)?.key;
    return typeof key === "string" ? key : "";
  });
}

/**
 * Zod issues are turned into plain sentences. A reviewer who is not an engineer
 * cannot act on "steps.3.settings.seconds: invalid_type", so the path never
 * reaches the message; only the setting's own name does.
 */
function shapeDefects(error: z.ZodError, keys: string[]): PlanDefect[] {
  const defects: PlanDefect[] = [];
  for (const issue of error.issues) {
    const [head, index, field, ...rest] = issue.path;
    const stepIndex = typeof index === "number" ? index : -1;
    const key = stepIndex >= 0 ? keys[stepIndex] || "" : "";
    const step = key || undefined;
    const who = named(key, stepIndex);
    const unknownKeys =
      issue.code === "unrecognized_keys" ? issue.keys.join(", ") : "";

    if (head !== "steps" || stepIndex < 0) {
      if (issue.code === "unrecognized_keys")
        defects.push({
          code: "unknown_plan_field",
          message: `This plan includes something the workflow builder does not read: ${unknownKeys}. Remove it.`,
        });
      else if (head === "steps")
        defects.push({
          code: "invalid_plan_shape",
          message: `A plan needs between ${MIN_STEPS} and ${MAX_STEPS} steps listed in order.`,
        });
      else
        defects.push({
          code: "invalid_plan_shape",
          message: `The plan's ${String(head || "outline")} is missing or unusable.`,
        });
      continue;
    }
    if (issue.code === "unrecognized_keys" && field === "settings") {
      defects.push({
        code: "unknown_setting",
        step,
        message: `${who} sets something this workflow engine never reads: ${unknownKeys}. It would be saved and then ignored, so remove it.`,
      });
      continue;
    }
    if (issue.code === "unrecognized_keys") {
      defects.push({
        code: "unknown_step_field",
        step,
        message: `${who} includes something a plan step does not have: ${unknownKeys}. Remove it.`,
      });
      continue;
    }
    if (field === "key") {
      defects.push({
        code: "invalid_key",
        step,
        message: `${who} needs a short name of 1 to 24 characters, starting with a lowercase letter and using only lowercase letters, numbers and underscores.`,
      });
      continue;
    }
    if (field === "label") {
      defects.push({
        code: "invalid_label",
        step,
        message: `${who} needs a label of 1 to 60 characters.`,
      });
      continue;
    }
    if (field === "settings") {
      const setting = rest.length ? String(rest[0]) : "";
      const missing = issue.code === "invalid_type" && issue.received === "undefined";
      defects.push({
        code: "invalid_setting",
        step,
        message: setting
          ? missing
            ? `${who} is missing a required setting: ${setting}.`
            : `${who} has an unusable value for the ${setting} setting.`
          : `${who} needs its settings written as a single group of values.`,
      });
      continue;
    }
    defects.push({
      code: "invalid_plan_shape",
      step,
      message: `${who} is missing or has an unusable ${String(field || "value")}.`,
    });
  }
  return defects;
}

/** Predecessor closure over `after`, cycle-safe. */
function upstreamOf(key: string, parents: Map<string, string[]>): Set<string> {
  const seen = new Set<string>();
  const queue = [...(parents.get(key) || [])];
  while (queue.length) {
    const next = queue.shift()!;
    if (seen.has(next)) continue;
    seen.add(next);
    queue.push(...(parents.get(next) || []));
  }
  return seen;
}

/**
 * The full review. `validatePlan` is the defect-only form named by the plan
 * contract; warnings and input requests are kept here because a warning must
 * never be repaired automatically and an input request is not a defect at all.
 *
 * Gates run in order and stop at the first gate that finds anything: once the
 * shape or the vocabulary is wrong, later gates would report consequences of the
 * same mistake rather than new information.
 */
export function reviewPlan(plan: unknown, vocab: PlanVocabulary = planVocabulary()): PlanReview {
  const defects: PlanDefect[] = [];
  const add = (code: PlanDefectCode, message: string, step?: string) =>
    defects.push({ code, step, message });
  const done = (): PlanReview => ({ defects: dedupe(defects), warnings: [], needsInput: [] });

  // Gate 1: shape.
  const parsed = planSchema.safeParse(plan);
  if (!parsed.success) {
    defects.push(...shapeDefects(parsed.error, rawStepKeys(plan)));
    return done();
  }
  const outline = parsed.data;
  const settings: PlanSettings[] = [];
  for (const [index, step] of outline.steps.entries()) {
    const schema = settingsSchemaFor(step.kind);
    if (!schema) {
      // Unknown or unsupported kind: the vocabulary gate names it properly.
      settings.push({});
      continue;
    }
    const value = step.settings;
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      add(
        "missing_settings",
        `${named(step.key, index)} needs its settings written as a single group of values.`,
        step.key,
      );
      settings.push({});
      continue;
    }
    const result = schema.safeParse(value);
    if (!result.success) {
      defects.push(
        ...shapeDefects(
          new z.ZodError(
            result.error.issues.map((issue) => ({
              ...issue,
              path: ["steps", index, "settings", ...issue.path],
            })),
          ),
          outline.steps.map((s) => s.key),
        ),
      );
      settings.push({});
      continue;
    }
    settings.push(result.data as PlanSettings);
  }
  if (defects.length) return done();

  const steps: PlanStep[] = outline.steps.map((step, index) => ({
    key: step.key,
    kind: step.kind as StepKind,
    label: step.label,
    after: [...step.after],
    ...(step.branch ? { branch: step.branch } : {}),
    settings: settings[index],
    rationale: step.rationale,
    budget: { ...step.budget },
  }));
  const typed: WorkflowPlan = {
    name: outline.name,
    description: outline.description,
    category: outline.category,
    steps,
    ...(outline.schedule
      ? {
          schedule: {
            frequency: outline.schedule.frequency,
            time: outline.schedule.time,
            days: [...outline.schedule.days],
          },
        }
      : {}),
    assumptions: [...outline.assumptions],
  };

  // Gate 2: vocabulary.
  const byKey = new Map<string, PlanStep>();
  for (const [index, step] of steps.entries()) {
    if (byKey.has(step.key))
      add(
        "duplicate_key",
        `Two steps share the short name “${step.key}”. Give ${named(step.key, index)} its own name.`,
        step.key,
      );
    else byKey.set(step.key, step);
  }
  for (const [index, step] of steps.entries()) {
    const who = named(step.key, index);
    if (!vocab.kinds.includes(step.kind)) {
      add("unknown_step_kind", `${who} uses a step type this workflow builder does not have: ${step.kind}.`, step.key);
      continue;
    }
    if (!settingsSchemaFor(step.kind)) {
      add(
        "python_not_generatable",
        `${who} is a Python transform, which cannot be generated. Sandbox code cannot be judged from a workflow diagram, so add and review that step yourself in the builder.`,
        step.key,
      );
      continue;
    }
    for (const parent of step.after)
      if (!byKey.has(parent))
        add("unknown_after", `${who} runs after “${parent}”, which is not a step in this plan.`, step.key);
    for (const context of step.settings.context || [])
      if (!byKey.has(context))
        add(
          "unknown_context_key",
          `${who} reads the result of “${context}”, which is not a step in this plan.`,
          step.key,
        );
    const tool = toolOf(step);
    if (tool && !vocab.tools.includes(tool))
      add(
        "unknown_tool",
        `${who} calls a service named “${tool}” that this workflow builder cannot use. Choose one of the approved services instead.`,
        step.key,
      );
    if (step.kind === "recipe" && step.settings.recipe && !vocab.recipes.includes(step.settings.recipe))
      add(
        "unknown_recipe",
        `${who} names an analysis template that does not exist: ${step.settings.recipe}.`,
        step.key,
      );
  }
  if (defects.length) return done();

  // Gate 3: semantics, including the run-time rules the adapter enforces.
  const parents = new Map(steps.map((step) => [step.key, step.after]));
  const triggers = steps.filter((step) => step.kind === "trigger");
  if (!triggers.length) add("missing_trigger", "This plan has no start step. Every workflow begins with one.");
  if (triggers.length > 1)
    add("multiple_triggers", "This plan has more than one start step. A workflow begins in exactly one place.");
  if (!steps.some((step) => step.kind === "response"))
    add(
      "missing_response",
      "This plan never presents a result. End it with a response step so the person running it sees the outcome.",
    );
  let requests = 0;
  for (const [index, step] of steps.entries()) {
    const who = named(step.key, index);
    const s = step.settings;
    requests += step.budget.modelRequests;
    if (step.budget.modelRequests > STEP_REQUESTS)
      add(
        "step_request_budget_exceeded",
        `${who} plans more model requests than one step is allowed to make (${STEP_REQUESTS}). Split the work across steps.`,
        step.key,
      );
    if (step.kind === "trigger" && step.after.length)
      add("trigger_has_predecessor", `${who} is the start step, so nothing can run before it.`, step.key);
    if (step.kind !== "trigger" && !step.after.length)
      add(
        "unreachable_step",
        `${who} never runs because nothing leads to it. Say which step comes before it.`,
        step.key,
      );
    if (step.after.includes(step.key))
      add("cycle", `${who} lists itself as its own predecessor. A workflow only moves forward.`, step.key);

    const upstream = upstreamOf(step.key, parents);
    if (upstream.has(step.key))
      add(
        "cycle",
        `${who} eventually leads back to itself. Remove the loop; a workflow only moves forward.`,
        step.key,
      );
    if (triggers.length === 1 && step.kind !== "trigger" && !upstream.has(triggers[0].key))
      add("unreachable_step", `${who} is not reachable from the start step.`, step.key);
    for (const context of s.context || [])
      if (!upstream.has(context))
        add(
          "context_not_upstream",
          `${who} reads the result of “${context}”, but that step does not run before it.`,
          step.key,
        );

    const conditions = step.after.filter((parent) => byKey.get(parent)?.kind === "condition");
    if (conditions.length > 1)
      add(
        "multiple_condition_predecessors",
        `${who} follows more than one condition, which a plan cannot express. Merge the branches first.`,
        step.key,
      );
    if (conditions.length === 1 && !step.branch)
      add(
        "branch_required",
        `${who} follows the “${conditions[0]}” condition, so say whether it is on the true or the false branch.`,
        step.key,
      );
    if (!conditions.length && step.branch)
      add(
        "branch_without_condition",
        `${who} names a true or false branch but does not follow a condition.`,
        step.key,
      );

    if (step.kind === "condition") {
      const children = steps.filter((other) => other.after.includes(step.key));
      if (children.length < 2)
        add(
          "condition_missing_branch",
          `${who} needs both outcomes connected: one step for true and one for false.`,
          step.key,
        );
      if (children.length > 2)
        add(
          "condition_extra_branch",
          `${who} has ${children.length} steps after it. A condition leads to exactly two.`,
          step.key,
        );
      if (children.length === 2) {
        const branches = children.map((child) => child.branch);
        if (!branches.includes("true") || !branches.includes("false"))
          add(
            "condition_missing_branch",
            `${who} needs one step on the true branch and one on the false branch.`,
            step.key,
          );
      }
      const root = (s.left || "").split(".")[0];
      if (s.left && !REFERENCE.test(s.left))
        add(
          "condition_left_not_upstream",
          `${who} evaluates “${s.left}”, which is not the result of an earlier step. Use a step's short name, optionally followed by a field.`,
          step.key,
        );
      else if (root && !upstream.has(root))
        add(
          "condition_left_not_upstream",
          `${who} evaluates “${s.left}”, but “${root}” does not run before it.`,
          step.key,
        );
      if (!["is_true", "exists"].includes(s.operator || "") && !(s.right || "").trim())
        add(
          "condition_right_required",
          `${who} compares a value, so it needs something to compare against.`,
          step.key,
        );
    }
    const seconds = typeof s.seconds === "number" ? s.seconds : Number.NaN;
    if (step.kind === "delay" && !(seconds >= DELAY_MIN && seconds <= DELAY_MAX))
      add(
        "delay_out_of_range",
        `${who} must wait between one second and 30 days (${DELAY_MAX} seconds).`,
        step.key,
      );
    if (step.kind === "review" && s.reviewer !== "owner" && !EMAIL.test(s.reviewer || ""))
      add(
        "invalid_reviewer",
        `${who} must be reviewed by the workflow owner or by one exact email address.`,
        step.key,
      );
    if (step.kind === "notify")
      for (const recipient of s.recipients || [])
        if (!EMAIL.test(recipient))
          add("invalid_recipient", `${who} lists a recipient that is not an email address: ${recipient}.`, step.key);
    if (step.kind === "scrape" && !/^https:\/\/[^\s]+$/.test(s.url || ""))
      add("invalid_url", `${who} needs one full web address beginning with https://.`, step.key);
    defects.push(...toolDefects(step, who));
  }
  if (requests > RUN_REQUESTS)
    add(
      "plan_request_budget_exceeded",
      `This plan asks for ${requests} model requests, and one run allows ${RUN_REQUESTS}. Remove or combine steps.`,
    );
  if (typed.schedule?.frequency === "weekly" && !typed.schedule.days.length)
    add("schedule_needs_weekday", "A weekly schedule needs at least one weekday chosen.");
  if (defects.length) return done();

  // Gate 4: materialize. From here the graph is coherent enough to build.
  const { workflow, needsInput } = materialize(typed);
  const keyOf = new Map(workflow.nodes.map((node) => [node.id, node.data.output]));

  // Gate 5: the structural authority. Warnings are reported, never repaired.
  const warnings: PlanWarning[] = [];
  for (const issue of validateWorkflow(workflow)) {
    const step = issue.nodeId ? keyOf.get(issue.nodeId) : undefined;
    if (issue.severity === "error") add("graph_error", issue.message, step);
    else warnings.push({ step, message: issue.message });
  }

  // Gate 6: the real server admission gate, run exactly as the server runs it.
  try {
    importWorkflow(exportWorkflow(workflow));
  } catch (e) {
    add("admission_failed", e instanceof Error ? e.message : "This plan cannot be saved as a workflow.");
  }
  if (defects.length) return { defects: dedupe(defects), warnings, needsInput };
  return { defects: [], warnings, needsInput, workflow };
}

/** Deterministic, model-free plan validation. Empty means the plan can be built. */
export function validatePlan(plan: unknown, vocab: PlanVocabulary = planVocabulary()): PlanDefect[] {
  return reviewPlan(plan, vocab).defects;
}

function dedupe(defects: PlanDefect[]): PlanDefect[] {
  const seen = new Set<string>();
  return defects.filter((defect) => {
    const key = `${defect.code}:${defect.step || ""}:${defect.message}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** The tool a step will actually call, including the ones the adapter defaults. */
function toolOf(step: PlanStep): string | undefined {
  const { kind, settings } = step;
  if (kind === "citations") return "verify_citations";
  if (kind === "mcp" || kind === "web") return settings.tool;
  if (kind === "search")
    return settings.source === "docketbird" ? settings.tool || "db_search_filings" : undefined;
  return undefined;
}

/**
 * The (kind, connection, tool) rules from adapter.server.ts:291-320 and the
 * argument contracts from tool-contracts.ts, applied before a plan is accepted.
 * Without this a plan validates, materializes, saves, and then fails with a 400
 * on its first run.
 */
function toolDefects(step: PlanStep, who: string): PlanDefect[] {
  const found: PlanDefect[] = [];
  const { kind, settings } = step;
  const push = (code: PlanDefectCode, message: string) => found.push({ code, step: step.key, message });

  if (kind === "search" && settings.source === "workspace" && settings.tool)
    push(
      "tool_not_used_here",
      `${who} searches your own document workspace, which does not call an outside service. Remove the service name or search the docket instead.`,
    );

  const tool = toolOf(step);
  if (!tool) return found;
  const contract = WORKFLOW_TOOLS[tool];
  // An unapproved name is already reported by the vocabulary gate.
  if (!contract) return found;

  // A web step carries no connector, so a docket service would run unauthenticated.
  if ((kind === "web" || (kind === "search" && settings.source === "workspace")) && contract.connection)
    push(
      "tool_requires_docketbird_connection",
      `${who} calls a docket service, which only works from a docket search step with the DocketBird connection. Use a docket search step instead.`,
    );
  if (kind === "search" && settings.source === "docketbird" && contract.connection !== "docketbird")
    push(
      "docketbird_connection_needs_docket_tool",
      `${who} searches the docket, so it needs one of the approved docket services rather than “${tool}”.`,
    );

  if (kind === "citations") return found; // The engine supplies this tool's arguments.
  const built =
    kind === "mcp"
      ? buildToolArgs(tool, { json: settings.args || {} })
      : buildToolArgs(tool, { query: settings.query || "" });
  if (!built.ok) push("tool_args_invalid", `${who}: ${built.message}`);
  return found;
}

/**
 * StepConfig built one field at a time, per kind.
 *
 * Never spread the plan's settings in here. importWorkflow copies node data
 * verbatim, so any extra key would be stored and displayed as configuration
 * while the engine ignores it. Absent settings are also left absent rather than
 * given an invented default, so a plan that skipped something fails loudly in
 * validateWorkflow instead of running with a value nobody chose.
 */
function stepConfig(kind: StepKind, s: PlanSettings): StepConfig {
  switch (kind) {
    case "trigger":
    case "files":
    case "compare":
    case "citations":
    case "foreach":
    case "merge":
    case "response":
    case "python":
      return {};
    case "text":
      return { value: s.value ?? "" };
    case "selection":
      return { options: [...(s.options ?? [])] };
    case "prompt":
    case "agent":
      // The host adapter is the only place these can run, so the model choice is
      // not the generator's to make.
      return {
        model: "bedrock",
        ...(s.instructions ? { instructions: s.instructions } : {}),
        context: [...(s.context ?? [])],
      };
    case "extract":
    case "table":
      return { fields: [...(s.fields ?? [])] };
    case "search":
      // `value` (the saved workspace) is deliberately absent; see needsInput.
      return s.source === "docketbird"
        ? { connection: "docketbird", query: s.query ?? "", ...(s.tool ? { tool: s.tool } : {}) }
        : { connection: "workspace", query: s.query ?? "" };
    case "condition":
      return {
        ...(s.left ? { left: s.left } : {}),
        ...(s.operator ? { operator: s.operator } : {}),
        right: s.right ?? "",
      };
    case "review":
      return {
        ...(s.reviewer ? { reviewer: s.reviewer } : {}),
        ...(s.instructions ? { instructions: s.instructions } : {}),
      };
    case "delay":
      return typeof s.seconds === "number" && Number.isFinite(s.seconds) ? { seconds: s.seconds } : {};
    case "document":
      return {
        ...(s.filename ? { filename: s.filename } : {}),
        ...(s.format ? { format: s.format } : {}),
        ...(s.instructions ? { instructions: s.instructions } : {}),
      };
    case "edit":
      return {
        ...(s.find ? { left: s.find } : {}),
        right: s.replace ?? "",
        ...(s.instructions ? { instructions: s.instructions } : {}),
      };
    case "notify":
      return {
        recipients: [...(s.recipients ?? [])],
        ...(s.instructions ? { instructions: s.instructions } : {}),
      };
    case "mcp":
      // The adapter reads a JSON object of tool arguments out of `query`, and it
      // requires the connector the tool itself declares.
      return {
        connection: (s.tool ? WORKFLOW_TOOLS[s.tool]?.connection : undefined) ?? "workspace",
        ...(s.tool ? { tool: s.tool } : {}),
        query: JSON.stringify(s.args ?? {}),
      };
    case "recipe":
      // No `model`, so this runs as deterministic evidence extraction.
      return {
        ...(s.recipe ? { recipe: s.recipe } : {}),
        ...(s.instructions ? { instructions: s.instructions } : {}),
        ...(s.fields ? { fields: [...s.fields] } : {}),
      };
    case "web":
      // The adapter routes web through the tool contract and never reads this
      // connection; it is set only so the builder's picker shows the key-free
      // option the catalog already defaults to.
      return { connection: "wikipedia", ...(s.tool ? { tool: s.tool } : {}), query: s.query ?? "" };
    case "scrape":
      return { connection: "public-web", ...(s.url ? { url: s.url } : {}) };
  }
}

/**
 * Turn an accepted plan into a Workflow. Identifiers, positions and outputs are
 * derived here, never taken from the plan.
 */
export function materialize(plan: WorkflowPlan): MaterializedPlan {
  const steps = Array.isArray(plan.steps) ? plan.steps : [];
  // Identifiers are per position, not per key, so two steps that share a key stay
  // two steps and validateWorkflow reports the duplicate output name.
  const ids = steps.map(() => crypto.randomUUID());
  const firstIndex = new Map<string, number>();
  steps.forEach((step, index) => {
    if (!firstIndex.has(step.key)) firstIndex.set(step.key, index);
  });

  const nodes: WorkflowStep[] = steps.map((step, index) => ({
    id: ids[index],
    type: "step",
    position: { x: 0, y: 0 },
    data: {
      kind: step.kind,
      label: step.label.slice(0, 60),
      output: step.key,
      config: stepConfig(step.kind, step.settings || {}),
    },
  }));
  const edges: WorkflowEdge[] = [];
  steps.forEach((step, index) => {
    for (const parent of step.after || []) {
      const from = firstIndex.get(parent);
      if (from === undefined) continue; // Unknown predecessors are a validation defect.
      const branching = steps[from].kind === "condition" && step.branch;
      edges.push({
        id: `${parent}-${step.key}`,
        source: ids[from],
        target: ids[index],
        ...(branching ? { sourceHandle: step.branch } : {}),
      });
    }
  });

  const needsInput: PlanInputRequest[] = [];
  for (const step of steps) {
    if (step.kind === "search" && step.settings?.source === "workspace")
      needsInput.push({
        step: step.key,
        need: "workspace",
        message: `Choose which of your saved document workspaces “${step.label}” should search.`,
      });
    if (step.kind === "notify" && !(step.settings?.recipients || []).length)
      needsInput.push({
        step: step.key,
        need: "recipients",
        message: `Add the email addresses “${step.label}” should address its draft message to.`,
      });
  }

  const schedule = plan.schedule;
  return {
    workflow: {
      schemaVersion: 1,
      id: crypto.randomUUID(),
      name: plan.name.slice(0, 100),
      description: plan.description.slice(0, 3000),
      category: plan.category.slice(0, 60) || "Litigation",
      nodes: tidyLayout(nodes, edges),
      edges,
      updatedAt: new Date().toISOString(),
      // The owner is whoever saves it; the plan does not get to claim authorship.
      createdBy: "",
      version: 0,
      dirty: true,
      schedule: {
        // Always off. A scaffold nobody has read yet must not start running.
        enabled: false,
        frequency: schedule?.frequency ?? "weekly",
        time: schedule?.time ?? "09:00",
        timezone: TIMEZONE,
        days: [...(schedule?.days ?? [1])],
      },
      sharing: { visibility: "private", teams: [], permission: "run" },
    },
    needsInput,
  };
}

const AI_STEPS: readonly StepKind[] = ["prompt", "agent", "extract", "table", "compare", "edit"];
const SERVICE_STEPS: readonly StepKind[] = ["search", "web", "scrape", "mcp", "citations"];

/**
 * A floor, not a measurement: chunked analysis steps issue one model request per
 * chunk, which depends on the documents supplied at run time.
 */
function estimateBudget(kind: StepKind, s: PlanSettings): PlanStep["budget"] {
  if (kind === "delay")
    return { modelRequests: 0, seconds: Math.max(0, Math.min(86_400, Math.trunc(s.seconds ?? 0))) };
  if (AI_STEPS.includes(kind)) return { modelRequests: 1, seconds: 60 };
  if (SERVICE_STEPS.includes(kind)) return { modelRequests: 0, seconds: 20 };
  return { modelRequests: 0, seconds: 5 };
}

/** Settings read out of a saved step, one field at a time, dropping what the plan does not model. */
function planSettings(kind: StepKind, config: StepConfig, rename: (output: string) => string): PlanSettings {
  const reference = (value: string) => {
    const [root, ...rest] = value.replace(/^\{\{|\}\}$/g, "").trim().split(".");
    return [rename(root), ...rest].join(".");
  };
  switch (kind) {
    case "trigger":
    case "files":
    case "compare":
    case "citations":
    case "foreach":
    case "merge":
    case "response":
    case "python":
      return {};
    case "text":
      return config.value ? { value: config.value } : {};
    case "selection":
      return { options: [...(config.options ?? [])] };
    case "prompt":
    case "agent":
      return {
        instructions: config.instructions ?? "",
        ...(config.context?.length ? { context: config.context.slice(0, MAX_CONTEXT).map(rename) } : {}),
      };
    case "extract":
    case "table":
      return { fields: [...(config.fields ?? [])] };
    case "search":
      // Only the two connections the plan can express are mapped. Anything else
      // is left unset so validation reports it, rather than quietly re-pointing a
      // private connector at the shared knowledge base.
      return {
        ...(config.connection === "docketbird"
          ? { source: "docketbird" as const, ...(config.tool ? { tool: config.tool } : {}) }
          : config.connection === "workspace"
            ? { source: "workspace" as const }
            : {}),
        query: config.query ?? "",
      };
    case "condition":
      return {
        left: config.left ? reference(config.left) : "",
        ...(config.operator ? { operator: config.operator } : {}),
        ...(config.right ? { right: config.right } : {}),
      };
    case "review":
      return { reviewer: config.reviewer ?? "owner", instructions: config.instructions ?? "" };
    case "delay":
      return { seconds: config.seconds ?? 0 };
    case "document":
      // The engine already treats a missing format as docx.
      return {
        filename: config.filename ?? "",
        format: config.format ?? "docx",
        instructions: config.instructions ?? "",
      };
    case "edit":
      return {
        find: config.left ?? "",
        replace: config.right ?? "",
        ...(config.instructions ? { instructions: config.instructions } : {}),
      };
    case "notify":
      return { recipients: [...(config.recipients ?? [])], instructions: config.instructions ?? "" };
    case "mcp": {
      let args: Record<string, unknown> = {};
      try {
        const parsed = JSON.parse(config.query || "{}");
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed))
          args = parsed as Record<string, unknown>;
      } catch {
        // An unreadable argument object stays empty; validation then reports it
        // against the tool's own contract instead of inventing arguments.
      }
      return { tool: config.tool ?? "", args };
    }
    case "recipe":
      return {
        recipe: config.recipe ?? "parties",
        ...(config.instructions ? { instructions: config.instructions } : {}),
        ...(config.fields?.length ? { fields: [...config.fields] } : {}),
      };
    case "web":
      // The adapter defaults a web step with no tool to web_search.
      return { tool: config.tool ?? "web_search", query: config.query ?? "" };
    case "scrape":
      return { url: config.url ?? "" };
  }
}

/**
 * The inverse of materialize, used to generate fixtures from saved workflows and
 * to describe an existing workflow back to a person. Output names are normalized
 * into plan keys and every reference to them is rewritten, because a saved output
 * may use characters or a length a plan key does not allow.
 */
export function planFromWorkflow(flow: Workflow): WorkflowPlan {
  const rename = new Map<string, string>();
  const used = new Set<string>();
  for (const node of flow.nodes) {
    const base =
      node.data.output
        .toLowerCase()
        .replace(/[^a-z0-9_]/g, "_")
        .replace(/^[^a-z]+/, "")
        .slice(0, 24) || "step";
    let key = base;
    for (let n = 2; used.has(key); n++) key = `${base.slice(0, 22)}_${n}`;
    used.add(key);
    rename.set(node.data.output, key);
  }
  const map = (output: string) => rename.get(output) ?? output;
  const keyOf = new Map(flow.nodes.map((node) => [node.id, map(node.data.output)]));

  const steps: PlanStep[] = flow.nodes.map((node) => {
    const incoming = flow.edges.filter((edge) => edge.target === node.id);
    const after: string[] = [];
    for (const edge of incoming) {
      const key = keyOf.get(edge.source);
      if (key && !after.includes(key)) after.push(key);
    }
    const branch = incoming.find(
      (edge) =>
        flow.nodes.find((other) => other.id === edge.source)?.data.kind === "condition" &&
        (edge.sourceHandle === "true" || edge.sourceHandle === "false"),
    )?.sourceHandle;
    const settings = planSettings(node.data.kind, node.data.config, map);
    return {
      key: map(node.data.output),
      kind: node.data.kind,
      label: node.data.label.slice(0, 60),
      after,
      ...(branch === "true" || branch === "false" ? { branch } : {}),
      settings,
      // The step's own catalog description: true of the step, and not a claim
      // about why this workflow needs it, which only its author knows.
      rationale: (catalog.find((item) => item.kind === node.data.kind)?.description || node.data.label).slice(0, 200),
      budget: estimateBudget(node.data.kind, settings),
    };
  });

  return {
    name: flow.name.slice(0, 100),
    description: flow.description.slice(0, 3000) || flow.name.slice(0, 100),
    category: flow.category.slice(0, 60) || "Litigation",
    steps,
    schedule: {
      frequency: flow.schedule.frequency,
      time: TIME.test(flow.schedule.time) ? flow.schedule.time : "09:00",
      days: flow.schedule.days.filter((day) => Number.isInteger(day) && day >= 0 && day <= 6),
    },
    assumptions: [],
  };
}

/**
 * Mechanical repairs only.
 *
 * Nothing here substitutes one meaning for another. In particular an unapproved
 * service name is never mapped to its nearest neighbour: turning search_westlaw
 * into web_search produces a workflow that runs and is quietly wrong, which is
 * worse than one that will not build. Unknown kinds, unknown services, bad
 * arguments and missing instructions are left as defects on purpose.
 */
export function autoFix(plan: WorkflowPlan): WorkflowPlan {
  const fixed: WorkflowPlan = structuredClone(plan);
  if (!Array.isArray(fixed.steps)) return fixed;
  if (!Array.isArray(fixed.assumptions)) fixed.assumptions = [];
  // The plan has no schedule switch; materializing always leaves it off, so a
  // stray one is removed rather than honoured.
  if (fixed.schedule) delete (fixed.schedule as { enabled?: unknown }).enabled;

  // Keys: legal shape, then uniqueness. References follow the first step that
  // held a name, so no reference is silently re-pointed at a different step.
  const first = new Map<string, string>();
  const used = new Set<string>();
  for (const step of fixed.steps) {
    const original = typeof step.key === "string" ? step.key : "";
    const base =
      original
        .toLowerCase()
        .replace(/[^a-z0-9_]/g, "_")
        .replace(/^[^a-z]+/, "")
        .slice(0, 24) || "step";
    let key = base;
    for (let n = 2; used.has(key); n++) key = `${base.slice(0, 22)}_${n}`;
    used.add(key);
    if (!first.has(original)) first.set(original, key);
    step.key = key;
    if (typeof step.label === "string") step.label = step.label.trim().slice(0, 60) || step.key;
  }
  const map = (name: string) => first.get(name) ?? name;
  for (const step of fixed.steps) {
    step.after = (Array.isArray(step.after) ? step.after : []).map(map);
    if (step.settings?.context) step.settings.context = step.settings.context.map(map);
    if (step.kind === "condition" && step.settings?.left) {
      const [root, ...rest] = step.settings.left.split(".");
      step.settings.left = [map(root), ...rest].join(".");
    }
  }

  // A start step, then anything left dangling is attached to the nearest earlier
  // step that already runs. Plan order is the author's own sequence, so this adds
  // no ordering the author did not write.
  if (!fixed.steps.some((step) => step.kind === "trigger")) {
    const key = freshKey("start", used);
    fixed.steps.unshift({
      key,
      kind: "trigger",
      label: "Start workflow",
      after: [],
      settings: {},
      rationale: "Every workflow needs one start step.",
      budget: { modelRequests: 0, seconds: 1 },
    });
  }
  const trigger = fixed.steps.find((step) => step.kind === "trigger")!;
  for (const step of fixed.steps)
    if (step !== trigger && !step.after.length) step.after = [trigger.key];
  reconnect(fixed, trigger);

  // A workflow that ends without presenting anything leaves the person running it
  // with nothing to read.
  if (!fixed.steps.some((step) => step.kind === "response")) {
    const ends = fixed.steps.filter(
      (step) =>
        step.kind !== "condition" && !fixed.steps.some((other) => other.after.includes(step.key)),
    );
    if (ends.length) {
      const key = freshKey("result", used);
      fixed.steps.push({
        key,
        kind: "response",
        label: "Present the result",
        after: ends.map((step) => step.key),
        settings: {},
        rationale: "Presents the finished result to the person running the workflow.",
        budget: { modelRequests: 0, seconds: 1 },
      });
    }
  }

  // A condition with one outcome connected: the other outcome goes straight to the
  // end. Only when the existing outcome says which branch it is; guessing that
  // would invent the routing rather than complete it.
  const end = [...fixed.steps].reverse().find((step) => step.kind === "response");
  for (const step of fixed.steps) {
    if (step.kind !== "condition") continue;
    const children = fixed.steps.filter((other) => other.after.includes(step.key));
    if (children.length !== 1 || !children[0].branch) continue;
    const missing = children[0].branch === "true" ? "false" : "true";
    if (!end || end === children[0] || end.after.includes(step.key)) continue;
    if (end.after.some((parent) => fixed.steps.find((s) => s.key === parent)?.kind === "condition"))
      continue;
    end.after.push(step.key);
    end.branch = missing;
  }
  return fixed;
}

function freshKey(base: string, used: Set<string>): string {
  let key = base;
  for (let n = 2; used.has(key); n++) key = `${base}_${n}`;
  used.add(key);
  return key;
}

/** Attach steps that nothing leads to, in plan order, to the closest earlier step that runs. */
function reconnect(plan: WorkflowPlan, trigger: PlanStep) {
  const parents = new Map(plan.steps.map((step) => [step.key, step.after]));
  const runs = (step: PlanStep) => upstreamOf(step.key, parents).has(trigger.key);
  for (const [index, step] of plan.steps.entries()) {
    if (step === trigger || runs(step)) continue;
    const earlier = plan.steps
      .slice(0, index)
      .reverse()
      .find((other) => other.kind !== "condition" && (other === trigger || runs(other)));
    step.after = [(earlier ?? trigger).key];
    parents.set(step.key, step.after);
  }
}
