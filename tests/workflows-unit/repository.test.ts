/* eslint-disable @typescript-eslint/no-explicit-any -- Test-only AWS command emulator handles heterogeneous document shapes. Production transport remains SDK-typed. */
import { beforeEach, describe, expect, mock, test } from "bun:test";
import { SQSClient } from "@aws-sdk/client-sqs";
import { blankWorkflow } from "../../src/lib/workflows/seeds";
import { makeStep } from "../../src/lib/workflows/catalog";
import { advanceRun } from "../../src/lib/workflows/engine";
import { createAppWorkflow } from "../../src/lib/workflows/app-templates";
import { WorkflowError, type Principal } from "../../src/lib/workflows/policy";
import type { WorkflowRun } from "../../src/lib/workflows/types";

// In-memory transport doubles exercise real repository policy/transactions without any AWS requests.
const items = new Map<string, any>(),
  objects = new Map<string, string>();
const key = (x: any) => x.PK + "|" + x.SK;
const conditional = () =>
  Object.assign(new Error("condition failed"), { name: "ConditionalCheckFailedException" });
let sent = 0;
SQSClient.prototype.send = mock(async () => {
  sent++;
  return {};
}) as any;
async function send(command: any) {
  const p = command.input;
  const check = (op: any) => {
    const current = items.get(key(op.Key || op.Item));
    const condition = op.ConditionExpression || "";
    if (
      condition.includes("revision = :r") &&
      current?.revision !== op.ExpressionAttributeValues[":r"]
    )
      throw conditional();
    if (condition.includes("attribute_not_exists(PK)") && current) throw conditional();
    if (condition.includes("attribute_not_exists(deleted)") && current?.deleted)
      throw conditional();
    if (
      condition.includes("#count < :limit") &&
      (current?.count || 0) >= op.ExpressionAttributeValues[":limit"]
    )
      throw conditional();
  };
  const apply = (op: any, type: string) => {
    if (type === "Put") items.set(key(op.Item), structuredClone(op.Item));
    if (type === "Delete") items.delete(key(op.Key));
    if (type === "Update") {
      const old = items.get(key(op.Key));
      items.set(key(op.Key), { ...op.Key, count: (old?.count || 0) + 1 });
    }
  };
  if (p.TransactItems) {
    for (const t of p.TransactItems) check(Object.values(t)[0]);
    for (const t of p.TransactItems) {
      const type = Object.keys(t)[0];
      apply(t[type], type);
    }
    return {};
  }
  if (p.Item) {
    check(p);
    apply(p, "Put");
    return {};
  }
  if (p.IndexName) {
    return {
      Items: [...items.values()]
        .filter(
          (r) =>
            r[`${p.IndexName}PK`] === p.ExpressionAttributeValues[":pk"] &&
            r[`${p.IndexName}SK`] <= p.ExpressionAttributeValues[":now"],
        )
        .slice(0, 100),
    };
  }
  throw new Error("Unexpected transport command " + command.constructor.name);
}
mock.module("../../src/lib/data/dynamo.server", () => ({
  tableName: () => "unit-test-table",
  doc: () => ({ send }),
  getItem: async (PK: string, SK: string) => structuredClone(items.get(key({ PK, SK }))),
  queryPrefix: async (PK: string, prefix: string, opts: any = {}) =>
    [...items.values()]
      .filter((r) => r.PK === PK && r.SK.startsWith(prefix))
      .sort((a, b) => (opts.scanForward === false ? -1 : 1) * a.SK.localeCompare(b.SK))
      .slice(0, opts.limit || 1000)
      .map((r) => structuredClone(r)),
}));
mock.module("../../src/lib/data/s3.server", () => ({
  bucketName: () => "unit-test-bucket",
  s3: () => ({
    send: async (c: any) => {
      if (c.input.Body !== undefined) {
        objects.set(c.input.Key, c.input.Body);
        return {};
      }
      const body = objects.get(c.input.Key);
      if (!body) throw new Error("Object not found");
      return { ContentLength: body.length, Body: { transformToString: async () => body } };
    },
  }),
}));
let refreshIdentity = async (p: Principal): Promise<Principal> => p;
mock.module("../../src/lib/workflows/identity.server", () => ({
  refreshWorkerPrincipal: (p: Principal) => refreshIdentity(p),
}));
const repo = await import("../../src/lib/workflows/repository.server");
const { processWorkflowRun } = await import("../../src/lib/workflows/worker.server");
const { productionAdapter } = await import("../../src/lib/workflows/adapter.server");
const owner = { sub: crypto.randomUUID(), email: "owner@example.test", groups: ["Team A"] };
const teammate = { sub: crypto.randomUUID(), email: "reviewer@example.test", groups: ["Team A"] };
const stranger = { sub: crypto.randomUUID(), email: "stranger@example.test", groups: [] };
const inputs = {
  text: "This is an isolated repository test source.",
  matter: "Test",
  selection: "Standard",
  files: [],
};
beforeEach(() => {
  items.clear();
  objects.clear();
  sent = 0;
  refreshIdentity = async (p) => p;
  process.env.SW_WORKFLOWS_ENABLED = "true";
  process.env.SW_DDB_TABLE = "unit-test-table";
  process.env.SW_S3_BUCKET = "unit-test-bucket";
  process.env.SW_WORKFLOWS_QUEUE_URL = "https://sqs.us-east-1.amazonaws.com/000000000000/unit-test";
  process.env.SW_WORKFLOWS_SCHEDULER_ENABLED = "true";
  process.env.SW_WORKFLOWS_DAILY_RUN_LIMIT = "20";
});

describe("production repository contracts", () => {
  test("unconfigured private app searches never fall back to a public web search", async () => {
    const step = makeStep("search", 1, { x: 0, y: 0 });
    step.data.config = { connection: "box", query: "private litigation evidence" };
    const runtime = productionAdapter(owner);
    await expect(
      runtime.adapter.executeStep!(step, { inputs, values: {}, files: [] }),
    ).rejects.toThrow("private search connection");
    step.data.config = {
      connection: "docketbird",
      tool: "web_search",
      query: "private litigation evidence",
    };
    await expect(
      runtime.adapter.executeStep!(step, { inputs, values: {}, files: [] }),
    ).rejects.toThrow("docket tool");
    expect(runtime.usage.requests).toBe(0);
  });
  test("server creates the real owner; caller metadata cannot change ownership or publish", async () => {
    const f = blankWorkflow();
    f.createdBy = "Spoofed";
    f.version = 99;
    f.publishedAt = "yesterday";
    const saved = await repo.saveDefinition(owner, f.id, f, 0);
    expect(saved.ownerId).toBe(owner.sub);
    expect(saved.createdBy).toBe(owner.email);
    expect(saved.version).toBe(0);
    expect(saved.publishedAt).toBeUndefined();
    await expect(repo.saveDefinition(stranger, f.id, f, 1)).rejects.toThrow("access");
    expect((await repo.listDefinitions(stranger)).length).toBe(0);
  });
  test("stale edits cannot overwrite a newer draft", async () => {
    const f = blankWorkflow();
    const first = await repo.saveDefinition(owner, f.id, f, 0);
    const second = await repo.saveDefinition(owner, f.id, { ...first, name: "Latest" }, 1);
    await expect(repo.saveDefinition(owner, f.id, { ...first, name: "Stale" }, 1)).rejects.toThrow(
      "another session",
    );
    expect((await repo.loadDefinition(owner, f.id)).flow.name).toBe("Latest");
    expect(second.revision).toBe(2);
  });
  test("revocation removes access even when an old group discovery link remains", async () => {
    const f = blankWorkflow();
    let saved = await repo.saveDefinition(owner, f.id, f, 0);
    saved = await repo.changeDefinition(owner, f.id, saved.revision!, "share", {
      visibility: "teams",
      teams: ["Team A"],
      permission: "run",
    });
    expect((await repo.listDefinitions(teammate)).length).toBe(1);
    await expect(repo.changeDefinition(teammate, f.id, saved.revision!, "publish")).rejects.toThrow(
      "access",
    );
    await repo.changeDefinition(owner, f.id, saved.revision!, "share", {
      visibility: "private",
      teams: [],
      permission: "view",
    });
    items.set("WFGROUP#Team A|DEF#" + f.id, { PK: "WFGROUP#Team A", SK: "DEF#" + f.id, id: f.id });
    expect((await repo.listDefinitions(teammate)).length).toBe(0);
  });
  test("published graph and form stay frozen across draft edits", async () => {
    const f = blankWorkflow();
    let saved = await repo.saveDefinition(owner, f.id, f, 0);
    saved = await repo.changeDefinition(owner, f.id, saved.revision!, "publish");
    const publishedId = saved.publishedGraph!.nodes[1].id;
    saved = await repo.saveDefinition(
      owner,
      f.id,
      {
        ...saved,
        nodes: saved.nodes.map((n) => ({ ...n, data: { ...n.data, label: "Changed draft" } })),
      },
      saved.revision!,
    );
    const run = await repo.startRun(owner, f.id, inputs, true, crypto.randomUUID());
    expect(run.graph.nodes.find((n) => n.id === publishedId)!.data.label).not.toBe("Changed draft");
    expect([...items.values()].some((r) => r.PK === "WFVERSION#" + f.id)).toBe(true);
  });
  test("start requests are deduplicated, limits are atomic, and strangers cannot inspect sources", async () => {
    process.env.SW_WORKFLOWS_DAILY_RUN_LIMIT = "1";
    const f = blankWorkflow();
    await repo.saveDefinition(owner, f.id, f, 0);
    const id = crypto.randomUUID();
    await repo.startRun(owner, f.id, inputs, false, id);
    await repo.startRun(owner, f.id, inputs, false, id);
    expect(sent).toBe(1);
    await expect(repo.startRun(owner, f.id, inputs, false, crypto.randomUUID())).rejects.toThrow(
      "daily run limit",
    );
    await expect(repo.loadRun(stranger, id)).rejects.toThrow("access");
    expect((await repo.listRuns(owner))[0].inputs.text).toBe("");
  });
  test("review and cancellation cannot be forged by a teammate", async () => {
    const f = blankWorkflow();
    const gate = makeStep("review", 2, { x: 0, y: 0 });
    gate.data.config.reviewer = teammate.email;
    f.nodes.splice(1, 0, gate);
    f.edges = [
      { id: "a", source: "start", target: gate.id },
      { id: "b", source: gate.id, target: "finish" },
    ];
    let saved = await repo.saveDefinition(owner, f.id, f, 0);
    saved = await repo.changeDefinition(owner, f.id, saved.revision!, "share", {
      visibility: "teams",
      teams: ["Team A"],
      permission: "run",
    });
    const run = await repo.startRun(owner, f.id, inputs, false, crypto.randomUUID());
    const waiting = await advanceRun(run);
    await repo.saveRun((await repo.runRecord(run.id))!, waiting);
    await expect(repo.actOnRun(owner, run.id, "review", true, "Spoof")).rejects.toThrow(
      "different person",
    );
    await expect(repo.actOnRun(teammate, run.id, "cancel")).rejects.toThrow("Only");
    const approved = await repo.actOnRun(teammate, run.id, "review", true, "Checked");
    expect(approved.status).toBe("running");
    expect(approved.logs.at(-1)?.message).toContain(teammate.email);
    const stale = (await repo.runRecord(run.id))!;
    await repo.actOnRun(owner, run.id, "cancel");
    await expect(repo.saveRun(stale, { ...approved, status: "completed" })).rejects.toThrow(
      "changed",
    );
    expect((await repo.loadRun(owner, run.id)).run.status).toBe("cancelled");
  });
  test("queue absence never silently uses browser execution", async () => {
    const f = blankWorkflow();
    await repo.saveDefinition(owner, f.id, f, 0);
    delete process.env.SW_WORKFLOWS_QUEUE_URL;
    await expect(repo.startRun(owner, f.id, inputs, false, crypto.randomUUID())).rejects.toThrow(
      "No run was started",
    );
    expect((await repo.listRuns(owner)).length).toBe(0);
  });
  test("scheduling requires owned real inputs and an immutable published version", async () => {
    const f = blankWorkflow();
    let saved = await repo.saveDefinition(owner, f.id, f, 0);
    await expect(
      repo.changeDefinition(owner, f.id, saved.revision!, "schedule", {
        ...f.schedule,
        enabled: true,
      }),
    ).rejects.toThrow("Publish");
    saved = await repo.changeDefinition(owner, f.id, saved.revision!, "publish");
    await expect(
      repo.changeDefinition(owner, f.id, saved.revision!, "schedule", {
        ...f.schedule,
        enabled: true,
      }),
    ).rejects.toThrow("previous run");
    const run = await repo.startRun(owner, f.id, inputs, true, crypto.randomUUID());
    saved = await repo.changeDefinition(owner, f.id, saved.revision!, "schedule", {
      ...f.schedule,
      enabled: true,
      inputRunId: run.id,
    });
    expect(saved.schedule.nextRun).toBeTruthy();
    expect(saved.schedule.inputRunId).toBe(run.id);
  });
  test("the queue worker checkpoints one step and never repeats a completed step", async () => {
    const f = blankWorkflow();
    await repo.saveDefinition(owner, f.id, f, 0);
    const run = await repo.startRun(owner, f.id, inputs, false, crypto.randomUUID());
    await processWorkflowRun(run.id);
    const first = (await repo.loadRun(owner, run.id)).run;
    expect(first.results.start.status).toBe("completed");
    expect(first.results.finish.status).toBe("pending");
    await processWorkflowRun(run.id);
    const finished = (await repo.loadRun(owner, run.id)).run;
    expect(finished.status).toBe("completed");
    expect(JSON.stringify(finished.results.start)).toBe(JSON.stringify(first.results.start));
    expect(JSON.stringify(finished.results.finish.output)).toContain(inputs.text);
    const before = sent;
    await processWorkflowRun(run.id);
    expect(sent).toBe(before);
  });
  test("a valid lease blocks duplicate delivery and current identity revocation stops execution", async () => {
    const f = blankWorkflow();
    await repo.saveDefinition(owner, f.id, f, 0);
    const run = await repo.startRun(owner, f.id, inputs, false, crypto.randomUUID());
    let record = (await repo.runRecord(run.id))!;
    await repo.saveRun(record, run, { lease: "another-worker", leaseUntil: Date.now() + 60000 });
    await processWorkflowRun(run.id);
    expect((await repo.loadRun(owner, run.id)).run.results.start.status).toBe("pending");
    record = (await repo.runRecord(run.id))!;
    await repo.saveRun(record, run, { lease: undefined, leaseUntil: undefined });
    refreshIdentity = async () => {
      throw new WorkflowError(403, "Account disabled");
    };
    await processWorkflowRun(run.id);
    expect((await repo.loadRun(owner, run.id)).run.status).toBe("cancelled");
  });
  test("downgrading a team from run to view stops a queued run", async () => {
    const f = blankWorkflow();
    let saved = await repo.saveDefinition(owner, f.id, f, 0);
    saved = await repo.changeDefinition(owner, f.id, saved.revision!, "publish");
    saved = await repo.changeDefinition(owner, f.id, saved.revision!, "share", {
      visibility: "teams",
      teams: ["Team A"],
      permission: "run",
    });
    const run = await repo.startRun(teammate, f.id, inputs, true, crypto.randomUUID());
    await repo.changeDefinition(owner, f.id, saved.revision!, "share", {
      visibility: "teams",
      teams: ["Team A"],
      permission: "view",
    });
    await processWorkflowRun(run.id);
    expect((await repo.loadRun(owner, run.id)).run.status).toBe("cancelled");
  });
  test("monitoring pins a prior snapshot from this user and workflow, never another user's sources", async () => {
    const f = createAppWorkflow("page-monitor");
    await repo.saveDefinition(owner, f.id, f, 0);
    const urlInputs = { ...inputs, text: "", fields: { url: "https://example.test/source" } };
    const first = await repo.startRun(owner, f.id, urlInputs, false, crypto.randomUUID());
    expect(first.inputs.files).toEqual([]);
    first.status = "completed";
    first.results.capture = {
      status: "completed",
      output: {
        requestUrl: urlInputs.fields.url,
        files: [{ id: "snapshot", name: "Source", text: "Original page text", size: 18 }],
      },
    };
    await repo.saveRun((await repo.runRecord(first.id))!, first);
    const next = await repo.startRun(owner, f.id, urlInputs, false, crypto.randomUUID());
    expect(next.inputs.files[0].text).toBe("Original page text");
    expect(next.inputs.fields?.baselineRunId).toBe(first.id);
    const differentUrl = await repo.startRun(
      owner,
      f.id,
      { ...urlInputs, fields: { url: "https://example.test/other" } },
      false,
      crypto.randomUUID(),
    );
    expect(differentUrl.inputs.files).toEqual([]);
  });
  test("one exhausted daily limit does not block another owner's due schedule", async () => {
    process.env.SW_WORKFLOWS_DAILY_RUN_LIMIT = "2";
    const due = "2026-01-01T09:00:00.000Z";
    const prepared = [];
    for (const person of [owner, stranger]) {
      const f = blankWorkflow();
      let saved = await repo.saveDefinition(person, f.id, f, 0);
      saved = await repo.changeDefinition(person, f.id, saved.revision!, "publish");
      const run = await repo.startRun(person, f.id, inputs, true, crypto.randomUUID());
      saved = await repo.changeDefinition(person, f.id, saved.revision!, "schedule", {
        ...f.schedule,
        enabled: true,
        inputRunId: run.id,
      });
      const row = items.get(`WF#DEF#${f.id}|META`);
      const stored = JSON.parse(objects.get(row.key)!);
      stored.schedule.nextRun = due;
      objects.set(row.key, JSON.stringify(stored));
      row.GSI2SK = `${due}#${f.id}`;
      prepared.push(f);
    }
    await repo.startRun(owner, prepared[0].id, inputs, true, crypto.randomUUID());
    await expect(repo.scheduledTick()).rejects.toThrow("Other due workflows");
    const failed = (await repo.loadDefinition(owner, prepared[0].id)).flow.schedule;
    const successful = (await repo.loadDefinition(stranger, prepared[1].id)).flow.schedule;
    expect(failed.nextRun).toBe(due);
    expect(failed.retryAt).toBeTruthy();
    expect(failed.lastError).toContain("daily run limit");
    expect(successful.lastRun).toBeTruthy();
    expect(successful.nextRun).not.toBe(due);
  });
});
