import { ancestors, validateWorkflow } from "./graph.ts";
import { analyzeRecipe, isAnalysisReport } from "./recipes.ts";
import { SOURCE_LIMITS } from "./source-policy.ts";
import { sourceFiles } from "./evidence.ts";
import type {
  Artifact,
  ExecutionContext,
  ExecutionResult,
  RunInputs,
  Workflow,
  WorkflowAdapter,
  WorkflowRun,
  WorkflowStep,
} from "./types";

export function displayValue(value: unknown): string {
  return typeof value === "string" ? value : (JSON.stringify(value, null, 2) ?? "");
}
export function resolveValue(values: Record<string, unknown>, path: string): unknown {
  const parts = path
    .replace(/^\{\{|\}\}$/g, "")
    .trim()
    .split(".");
  let current: unknown = values;
  for (const part of parts) {
    if (
      ["__proto__", "prototype", "constructor"].includes(part) ||
      !current ||
      typeof current !== "object" ||
      !Object.hasOwn(current, part)
    )
      return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}
export function interpolate(text: string, values: Record<string, unknown>): string {
  return text.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, key) => {
    const value = resolveValue(values, key);
    return value === undefined ? `[Missing: ${key}]` : displayValue(value);
  });
}
export function conditionMatches(step: WorkflowStep, values: Record<string, unknown>): boolean {
  const actual = resolveValue(values, step.data.config.left || "");
  const expected = step.data.config.right || "";
  if (step.data.config.operator !== "exists" && (actual === undefined || actual === null))
    throw new Error(
      "A branch input is missing or unknown. Supply an explicit value before routing this workflow.",
    );
  switch (step.data.config.operator) {
    case "is_true":
      if (![true, false, "true", "false"].includes(actual as boolean | string))
        throw new Error("The branch requires an explicit true or false value.");
      return actual === true || actual === "true";
    case "contains":
      return (
        actual !== undefined && displayValue(actual).toLowerCase().includes(expected.toLowerCase())
      );
    case "equals":
      return actual !== undefined && String(actual).toLowerCase() === expected.toLowerCase();
    case "greater_than":
      if (
        String(actual).trim() === "" ||
        expected.trim() === "" ||
        !Number.isFinite(Number(actual)) ||
        !Number.isFinite(Number(expected))
      )
        throw new Error("The branch requires two valid numeric values.");
      return (
        actual !== undefined &&
        String(actual).trim() !== "" &&
        expected.trim() !== "" &&
        Number.isFinite(Number(actual)) &&
        Number.isFinite(Number(expected)) &&
        Number(actual) > Number(expected)
      );
    case "exists":
      return actual !== undefined && actual !== null && actual !== "";
    default:
      return false;
  }
}
const cleanName = (name: string) =>
  name
    // Windows output filenames must exclude control characters as well as reserved punctuation.
    // eslint-disable-next-line no-control-regex
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, "")
    .trim()
    .slice(0, 100) || "Workflow output";
const sources = sourceFiles;
const sourceText = (ctx: ExecutionContext) =>
  sources(ctx)
    .map((file) => `${file.name}\n${file.text}`)
    .join("\n\n");
function lastText(ctx: ExecutionContext): string {
  const values = Object.values(ctx.values).reverse();
  const match = values.find(
    (v) => v && typeof v === "object" && typeof (v as Record<string, unknown>).text === "string",
  ) as { text: string } | undefined;
  return match?.text || sourceText(ctx);
}
function csv(rows: Record<string, unknown>[]) {
  if (!rows.length) return "No records\r\n";
  const keys = Object.keys(rows[0]);
  const quote = (value: unknown) => {
    let text = displayValue(value ?? "");
    if (/^[=+@-]/.test(text)) text = "'" + text;
    return `"${text.replaceAll('"', '""')}"`;
  };
  return [
    keys.map(quote).join(","),
    ...rows.map((row) => keys.map((key) => quote(row[key])).join(",")),
  ].join("\r\n");
}
export async function executeLocalStep(
  step: WorkflowStep,
  ctx: ExecutionContext,
): Promise<ExecutionResult> {
  const config = step.data.config,
    text = sourceText(ctx);
  switch (step.data.kind) {
    case "recipe":
      if (config.model === "bedrock")
        throw new Error(
          "This analysis requires the approved host AI adapter. Select local analysis or connect an evidence-checked host adapter.",
        );
      return analyzeRecipe(config.recipe || "parties", ctx, config);
    case "web":
    case "scrape":
      throw new Error("This step requires the platform web service.");
    case "trigger":
      return {
        output: {
          matter: ctx.inputs.matter,
          text: ctx.inputs.text,
          fileCount: ctx.files.length,
          selection: ctx.inputs.selection,
          fields: ctx.inputs.fields || {},
        },
      };
    case "files":
      return { output: { files: sources(ctx), count: sources(ctx).length } };
    case "text":
      return { output: { text: config.value?.trim() || ctx.inputs.text } };
    case "selection":
      if (!config.options?.includes(ctx.inputs.selection))
        throw new Error("Choose a valid workflow selection before running.");
      return {
        output: {
          selection: ctx.inputs.selection,
        },
      };
    case "extract":
      throw new Error("Document extraction requires the server analysis service.");
    case "condition":
      return {
        output: {
          branch: conditionMatches(step, ctx.values),
          value: resolveValue(ctx.values, config.left || ""),
          expression: `${config.left} ${config.operator} ${config.right || ""}`.trim(),
        },
      };
    case "prompt":
    case "agent":
    case "table":
    case "compare":
    case "citations":
    case "search":
    case "mcp":
      throw new Error("This step requires its configured server service.");
    case "foreach":
      return {
        output: {
          items: sources(ctx).map((f, i) => ({
            index: i + 1,
            name: f.name,
            text: f.text,
            characterCount: f.text.length,
          })),
          count: sources(ctx).length,
        },
      };
    case "merge":
      return {
        output: Object.fromEntries(Object.entries(ctx.values).filter(([key]) => key !== "input")),
      };
    case "edit":
      throw new Error("Document editing requires the server analysis service.");
    case "document": {
      const format = config.format || "docx";
      const filename = cleanName(config.filename || "Review memorandum");
      const content = `${filename}\n${"=".repeat(Math.min(filename.length, 65))}\n\nMatter: ${ctx.inputs.matter || "Not specified"}\nPrepared: ${new Date().toLocaleDateString("en-US")}\nStatus: Draft for review\n\n${lastText(ctx)}\n\nSource documents\n${sources(
        ctx,
      )
        .map((f, i) => `${i + 1}. ${f.name}`)
        .join(
          "\n",
        )}\n\n${config.instructions ? interpolate(config.instructions, ctx.values) + "\n\n" : ""}Workflow draft. Review source documents and all legal conclusions before use.`;
      return {
        output: { text: content, filename: `${filename}.${format}` },
        artifacts: [{ name: `${filename}.${format}`, format, content }],
      };
    }
    case "notify": {
      const recipients = config.recipients || [];
      const message = `To: ${recipients.join(", ")}\nSubject: Workflow review — ${ctx.inputs.matter}\n\n${interpolate(config.instructions || "Ready for review.", ctx.values)}\n\n${lastText(ctx)}\n\nDraft only — no message has been sent.`;
      return {
        output: { recipients, text: message, sent: false },
        artifacts: [{ name: "Team notification.txt", format: "txt", content: message }],
      };
    }
    case "response":
      return { output: { text: lastText(ctx), status: "Ready for review" } };
    case "python":
      throw new Error(
        "Connect a sandboxed Python execution adapter. Code is saved in this step but is not executed by the browser.",
      );
    default:
      return { output: {} };
  }
}
export function createRun(
  flow: Workflow,
  inputs: RunInputs,
  source: WorkflowRun["source"] = "manual",
  published = false,
): WorkflowRun {
  const graph =
    published && flow.publishedGraph
      ? flow.publishedGraph
      : { nodes: flow.nodes, edges: flow.edges };
  const errors = validateWorkflow({ ...flow, ...graph }).filter(
    (issue) => issue.severity === "error",
  );
  if (errors.length) throw new Error(errors[0].message);
  if (
    inputs.text.length + inputs.files.reduce((sum, f) => sum + f.text.length, 0) >
    SOURCE_LIMITS.runCharacters
  )
    throw new Error(
      "Use no more than 1,000,000 source characters per run. Split larger matters into identified batches; no input was truncated.",
    );
  return {
    id: crypto.randomUUID(),
    workflowId: flow.id,
    workflowName: flow.name,
    version: flow.version,
    graph: structuredClone(graph),
    status: "running",
    startedAt: new Date().toISOString(),
    inputs: structuredClone(inputs),
    results: Object.fromEntries(graph.nodes.map((n) => [n.id, { status: "pending" }])),
    logs: [],
    artifacts: [],
    mode: "local",
    source,
  };
}
const resolved = (status?: string) => status === "completed" || status === "skipped";
function contextFor(run: WorkflowRun, nodeId: string): ExecutionContext {
  const order = new Map(run.logs.map((log, index) => [log.nodeId, index]));
  const completed = ancestors(nodeId, run.graph.nodes, run.graph.edges)
    .filter((n) => run.results[n.id]?.status === "completed")
    .sort((a, b) => (order.get(a.id) || 0) - (order.get(b.id) || 0));
  return {
    inputs: run.inputs,
    files: run.inputs.files,
    values: Object.fromEntries(completed.map((n) => [n.data.output, run.results[n.id].output])),
  };
}
export async function advanceRun(
  initial: WorkflowRun,
  options: {
    adapter?: WorkflowAdapter;
    signal?: AbortSignal;
    onUpdate?: (run: WorkflowRun) => void | Promise<void>;
    maxSteps?: number;
    stepDelay?: number;
  } = {},
): Promise<WorkflowRun> {
  const run = structuredClone(initial);
  if (["completed", "rejected", "cancelled"].includes(run.status)) return run;
  run.status = "running";
  const publish = () => options.onUpdate?.(structuredClone(run));
  const log = (
    message: string,
    nodeId?: string,
    level: "info" | "success" | "warning" | "error" = "info",
  ) =>
    run.logs.push({
      id: crypto.randomUUID(),
      time: new Date().toISOString(),
      nodeId,
      message,
      level,
    });
  const finish = async (status: WorkflowRun["status"]) => {
    run.status = status;
    if (status !== "waiting" && status !== "running") run.endedAt = new Date().toISOString();
    await publish();
    return run;
  };
  for (const node of run.graph.nodes)
    if (run.results[node.id]?.status === "waiting") {
      const result = run.results[node.id];
      if (
        node.data.kind === "delay" &&
        result.resumeAt &&
        Date.parse(result.resumeAt) <= Date.now()
      ) {
        result.status = "completed";
        result.output = { waitedSeconds: node.data.config.seconds };
        result.endedAt = new Date().toISOString();
        log("Wait complete. Continuing workflow.", node.id, "success");
      } else return finish("waiting");
    }
  let executedCount = 0;
  for (let pass = 0; pass <= run.graph.nodes.length; pass++) {
    let progress = false;
    for (const node of run.graph.nodes) {
      if (options.signal?.aborted) {
        log("Run cancelled.", undefined, "warning");
        return finish("cancelled");
      }
      const result = run.results[node.id];
      if (result.status !== "pending") continue;
      if (options.maxSteps && executedCount >= options.maxSteps) return finish("running");
      const incoming = run.graph.edges.filter((e) => e.target === node.id);
      if (!incoming.every((e) => resolved(run.results[e.source]?.status))) continue;
      const active =
        incoming.length === 0 ||
        incoming.some((e) => {
          if (run.results[e.source]?.status !== "completed") return false;
          const parent = run.graph.nodes.find((n) => n.id === e.source)!;
          return (
            parent.data.kind !== "condition" ||
            String((run.results[e.source].output as { branch: boolean }).branch) === e.sourceHandle
          );
        });
      progress = true;
      if (!active) {
        result.status = "skipped";
        log("Skipped: this branch was not selected.", node.id);
        await publish();
        continue;
      }
      result.status = "running";
      result.startedAt = new Date().toISOString();
      log(node.data.label, node.id);
      await publish();
      if (options.stepDelay) await new Promise((resolve) => setTimeout(resolve, options.stepDelay));
      if (options.signal?.aborted) {
        result.status = "pending";
        log("Run cancelled.", node.id, "warning");
        return finish("cancelled");
      }
      if (node.data.kind === "review" || node.data.kind === "delay") {
        result.status = "waiting";
        if (node.data.kind === "delay") {
          result.resumeAt = new Date(
            Date.now() + (node.data.config.seconds || 1) * 1000,
          ).toISOString();
          log(`Waiting ${node.data.config.seconds} seconds.`, node.id, "warning");
        } else
          log(
            `Awaiting review by ${node.data.config.reviewer || "the workflow owner"}.`,
            node.id,
            "warning",
          );
        return finish("waiting");
      }
      try {
        const ctx = { ...contextFor(run, node.id), signal: options.signal };
        const connected =
          options.adapter?.executeStep &&
          (options.adapter.canExecute
            ? options.adapter.canExecute(node)
            : ["prompt", "agent"].includes(node.data.kind)
              ? node.data.config.model === "bedrock"
              : [
                  "python",
                  "mcp",
                  "search",
                  "extract",
                  "citations",
                  "table",
                  "compare",
                  "edit",
                  "web",
                  "scrape",
                ].includes(node.data.kind));
        const executed = connected
          ? await options.adapter!.executeStep!(node, ctx)
          : await executeLocalStep(node, ctx);
        if (options.signal?.aborted) {
          result.status = "pending";
          return finish("cancelled");
        }
        if (connected) run.mode = "connected";
        if (
          executed.output &&
          typeof executed.output === "object" &&
          "type" in executed.output &&
          executed.output.type === "analysis-report" &&
          !isAnalysisReport(executed.output)
        )
          throw new Error(
            "The analysis service returned a malformed report. No unvalidated table was displayed.",
          );
        executedCount++;
        result.output = executed.output;
        result.status = "completed";
        result.endedAt = new Date().toISOString();
        for (const artifact of executed.artifacts || [])
          run.artifacts.push({
            ...artifact,
            id: crypto.randomUUID(),
            nodeId: node.id,
          });
        log(
          node.data.kind === "condition"
            ? `Condition is ${(executed.output as { branch: boolean }).branch ? "true" : "false"}.`
            : `${node.data.label} completed.`,
          node.id,
          "success",
        );
        await publish();
      } catch (error) {
        if (options.signal?.aborted) {
          result.status = "pending";
          log("Run cancelled.", node.id, "warning");
          return finish("cancelled");
        }
        result.status = "failed";
        result.error = error instanceof Error ? error.message : "The step could not be completed.";
        log(result.error, node.id, "error");
        return finish("failed");
      }
    }
    if (Object.values(run.results).every((r) => resolved(r.status))) {
      log("Workflow completed. Outputs are ready for review.", undefined, "success");
      return finish("completed");
    }
    if (!progress) {
      log("No step can proceed. Check the workflow connections.", undefined, "error");
      return finish("failed");
    }
  }
  return finish("failed");
}
export function reviewRun(
  initial: WorkflowRun,
  approved: boolean,
  reviewer: string,
  notes: string,
): WorkflowRun {
  const run = structuredClone(initial);
  const node = run.graph.nodes.find(
    (n) => n.data.kind === "review" && run.results[n.id]?.status === "waiting",
  );
  if (!node || run.status !== "waiting") throw new Error("This run is not awaiting a review.");
  run.results[node.id] = {
    ...run.results[node.id],
    status: "completed",
    endedAt: new Date().toISOString(),
    output: {
      approved,
      reviewer,
      notes,
      text: `Review decision: ${approved ? "Approved to continue" : "Rejected"}\nReviewer: ${reviewer}\nNotes: ${notes || "No additional notes"}\n\n${lastText(contextFor(run, node.id))}`,
    },
  };
  run.status = approved ? "running" : "rejected";
  if (!approved) run.endedAt = new Date().toISOString();
  run.logs.push({
    id: crypto.randomUUID(),
    time: new Date().toISOString(),
    nodeId: node.id,
    message: `${approved ? "Approved" : "Rejected"} by ${reviewer}${notes ? ": " + notes : "."}`,
    level: approved ? "success" : "warning",
  });
  return run;
}
