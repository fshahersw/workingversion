import { advanceRun } from "./engine";
import { permission, WorkflowError } from "./policy";
import { productionAdapter } from "./adapter.server";
import {
  runRecord,
  readWorkerRun,
  saveRun,
  definitionRecord,
  enqueue,
  configured,
} from "./repository.server";
import { refreshWorkerPrincipal } from "./identity.server";

export async function processWorkflowRun(id: string) {
  if (!configured()) throw new Error("Workflow workers are disabled.");
  let record = await runRecord(id);
  if (!record || !["running", "waiting"].includes(record.status) || record.cancelRequested) return;
  if (record.leaseUntil && record.leaseUntil > Date.now()) return;
  const initial = await readWorkerRun(record);
  try {
    record.principal = await refreshWorkerPrincipal(record.principal);
  } catch (e) {
    if (!(e instanceof WorkflowError) || e.status !== 403) throw e;
    initial.status = "cancelled";
    initial.endedAt = new Date().toISOString();
    initial.logs.push({
      id: crypto.randomUUID(),
      time: initial.endedAt,
      message: "The submitting account is no longer authorized. Execution stopped.",
      level: "warning",
    });
    await saveRun(record, initial);
    return;
  }
  const definition = await definitionRecord(record.workflowId);
  const access = definition ? permission(record.principal, definition) : undefined;
  const allowed = record.requiredAccess === "edit" ? ["owner", "edit"] : ["owner", "edit", "run"];
  if (!access || !allowed.includes(access)) {
    initial.status = "cancelled";
    initial.endedAt = new Date().toISOString();
    initial.logs.push({
      id: crypto.randomUUID(),
      time: initial.endedAt,
      message: "Workflow access was withdrawn. Execution stopped.",
      level: "warning",
    });
    await saveRun(record, initial);
    return;
  }
  // Recover an interrupted step; completed steps remain immutable. External writes are not supported by this worker.
  for (const result of Object.values(initial.results))
    if (result.status === "running") result.status = "pending";
  const lease = crypto.randomUUID(),
    leaseUntil = Date.now() + 880000;
  try {
    record = await saveRun(record, initial, { lease, leaseUntil });
  } catch (e) {
    if (e instanceof WorkflowError && e.status === 409) return;
    throw e;
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 780000);
  const priorUsage = initial.usage || { input: 0, output: 0, requests: 0 };
  const runtime = productionAdapter(record.principal, priorUsage.requests);
  const cancellationCheck = setInterval(() => {
    void runRecord(id)
      .then((latest) => {
        if (
          !latest ||
          latest.cancelRequested ||
          latest.status === "cancelled" ||
          latest.lease !== lease
        )
          controller.abort();
      })
      .catch(() => controller.abort());
  }, 5000);
  try {
    const result = await advanceRun(initial, {
      adapter: runtime.adapter,
      signal: controller.signal,
      maxSteps: 1,
      onUpdate: async (run) => {
        const latest = await runRecord(id);
        if (
          !latest ||
          latest.cancelRequested ||
          latest.status === "cancelled" ||
          latest.lease !== lease ||
          latest.revision !== record!.revision
        ) {
          controller.abort();
          throw new WorkflowError(409, "Run ownership changed during execution.");
        }
        run.usage = {
          input: priorUsage.input + runtime.usage.input,
          output: priorUsage.output + runtime.usage.output,
          requests: priorUsage.requests + runtime.usage.requests,
        };
        record = await saveRun(record!, run, { lease, leaseUntil });
      },
    });
    const latest = await runRecord(id);
    if (!latest || latest.lease !== lease || latest.cancelRequested) return;
    result.usage = {
      input: priorUsage.input + runtime.usage.input,
      output: priorUsage.output + runtime.usage.output,
      requests: priorUsage.requests + runtime.usage.requests,
    };
    await saveRun(record!, result, { lease: undefined, leaseUntil: undefined });
    if (result.status === "running") await enqueue(id);
  } catch (e) {
    if (e instanceof WorkflowError && e.status === 409) return;
    throw e; // SQS retries infrastructure failures. The due index recovers a lost delivery after lease expiry.
  } finally {
    clearTimeout(timeout);
    clearInterval(cancellationCheck);
  }
}
