import { GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import {
  TransactWriteCommand,
  PutCommand,
  QueryCommand,
  type TransactWriteCommandInput,
} from "@aws-sdk/lib-dynamodb";
import { SendMessageCommand, SQSClient } from "@aws-sdk/client-sqs";
import { createHash } from "node:crypto";
import { doc, tableName, getItem, queryPrefix } from "../data/dynamo.server";
import { s3, bucketName } from "../data/s3.server";
import { createRun, reviewRun } from "./engine";
import { nextScheduledRun } from "./schedule";
import { refreshWorkerPrincipal } from "./identity.server";
import {
  authorize,
  permission,
  validateSharing,
  parseDefinition,
  assertRunnable,
  canReadRun,
  canReview,
  WorkflowError,
  type Principal,
} from "./policy";
import type { Workflow, WorkflowRun, RunInputs } from "./types";

export type DefinitionRecord = {
  PK: string;
  SK: string;
  id: string;
  owner: string;
  revision: number;
  key: string;
  sharing: Workflow["sharing"];
  deleted?: boolean;
  schedule?: Workflow["schedule"];
  scheduler?: Principal;
  GSI2PK?: string;
  GSI2SK?: string;
};
export type RunRecord = {
  PK: string;
  SK: string;
  id: string;
  workflowId: string;
  owner: string;
  principal: Principal;
  reviewers: string[];
  revision: number;
  key: string;
  status: WorkflowRun["status"];
  startedAt: string;
  workflowName: string;
  version: number;
  source: WorkflowRun["source"];
  requiredAccess?: "edit" | "run";
  lease?: string;
  leaseUntil?: number;
  cancelRequested?: boolean;
  GSI1PK?: string;
  GSI1SK?: string;
};
const now = () => new Date().toISOString();
const keyFor = (type: string, id: string) => ({ PK: `WF#${type}#${id}`, SK: "META" });
export const queueEnabled = () => Boolean(process.env.SW_WORKFLOWS_QUEUE_URL);
export function configured() {
  return (
    process.env.SW_WORKFLOWS_ENABLED === "true" &&
    Boolean(process.env.SW_DDB_TABLE && process.env.SW_S3_BUCKET)
  );
}
export function requireConfigured() {
  if (!configured())
    throw new WorkflowError(
      503,
      "Workflows is not enabled in this environment. Configure workflow storage and workers first.",
    );
}
async function readJson<T>(key: string): Promise<T> {
  if (!key.startsWith("workflows/")) throw new Error("Invalid workflow storage key.");
  const r = await s3().send(new GetObjectCommand({ Bucket: bucketName(), Key: key }));
  if ((r.ContentLength || 0) > 25_000_000)
    throw new Error("Stored workflow exceeds the result limit.");
  const text = await r.Body?.transformToString();
  if (!text) throw new Error("Workflow object unavailable.");
  return JSON.parse(text);
}
async function writeJson(kind: string, id: string, value: unknown) {
  const body = JSON.stringify(value);
  if (Buffer.byteLength(body) > 25_000_000)
    throw new WorkflowError(413, "The result exceeds 25 MB. Split this work into smaller batches.");
  const key = `workflows/${kind}/${id}/${crypto.randomUUID()}.json`;
  await s3().send(
    new PutObjectCommand({
      Bucket: bucketName(),
      Key: key,
      Body: body,
      ContentType: "application/json",
      ChecksumSHA256: createHash("sha256").update(body).digest("base64"),
    }),
  );
  return key;
}
function conditionalFailure(error: unknown) {
  return ["ConditionalCheckFailedException", "TransactionCanceledException"].includes(
    (error as Error)?.name,
  );
}
export async function definitionRecord(id: string) {
  return (await getItem(keyFor("DEF", id).PK, "META", { consistent: true })) as
    | DefinitionRecord
    | undefined;
}
function accessibleDefinition(flow: Workflow, record: DefinitionRecord, user: Principal): Workflow {
  const access = permission(user, record);
  return {
    ...flow,
    ...(["view", "run"].includes(access || "") && flow.publishedGraph
      ? { ...flow.publishedGraph, app: flow.publishedApp, dirty: false }
      : {}),
    revision: record.revision,
    ownerId: record.owner,
    access,
  };
}
export async function loadDefinition(
  user: Principal,
  id: string,
  action: "view" | "run" | "edit" | "owner" = "view",
) {
  const record = await definitionRecord(id);
  if (!record) throw new WorkflowError(404, "Workflow not found.");
  authorize(user, record, action);
  const flow = await readJson<Workflow>(record.key);
  return {
    record,
    flow: accessibleDefinition(flow, record, user),
  };
}
export async function listDefinitions(user: Principal) {
  const partitions = [`WFUSER#${user.sub}`, ...user.groups.slice(0, 30).map((g) => `WFGROUP#${g}`)];
  const links = (
    await Promise.all(partitions.map((p) => queryPrefix(p, "DEF#", { limit: 100 })))
  ).flat();
  const ids = [...new Set(links.map((l) => String(l.id)))];
  const results: Workflow[] = [];
  for (let i = 0; i < ids.length; i += 8) {
    const batch = await Promise.all(
      ids.slice(i, i + 8).map(async (id) => {
        const record = await definitionRecord(id);
        if (!record || !permission(user, record)) return;
        const f = await readJson<Workflow>(record.key);
        return accessibleDefinition(f, record, user);
      }),
    );
    results.push(...(batch.filter(Boolean) as Workflow[]));
  }
  return results.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}
async function commitDefinition(
  record: DefinitionRecord,
  flow: Workflow,
  expected: number,
  old?: DefinitionRecord,
  publish = false,
) {
  const key = await writeJson("definitions", record.id, flow);
  const row = {
    ...record,
    key,
    revision: expected + 1,
    schedule: flow.schedule,
    sharing: flow.sharing,
    GSI2PK: flow.schedule.enabled && !record.deleted ? "WF_SCHEDULE" : undefined,
    GSI2SK:
      flow.schedule.enabled && !record.deleted
        ? `${flow.schedule.retryAt || flow.schedule.nextRun}#${record.id}`
        : undefined,
  };
  const prev = new Set(old?.sharing.visibility === "teams" ? old.sharing.teams : []);
  const next = new Set(
    !record.deleted && flow.sharing.visibility === "teams" ? flow.sharing.teams : [],
  );
  const transact: NonNullable<TransactWriteCommandInput["TransactItems"]> = [
    {
      Put: {
        TableName: tableName(),
        Item: row,
        ConditionExpression: expected ? "revision = :r" : "attribute_not_exists(PK)",
        ...(expected ? { ExpressionAttributeValues: { ":r": expected } } : {}),
      },
    },
  ];
  if (publish)
    transact.push({
      Put: {
        TableName: tableName(),
        Item: {
          PK: `WFVERSION#${record.id}`,
          SK: `VERSION#${String(flow.version).padStart(8, "0")}`,
          key,
          version: flow.version,
          publishedAt: flow.publishedAt,
        },
        ConditionExpression: "attribute_not_exists(PK)",
      },
    });
  const ownerLink = { PK: `WFUSER#${record.owner}`, SK: `DEF#${record.id}` };
  transact.push(
    record.deleted
      ? { Delete: { TableName: tableName(), Key: ownerLink } }
      : { Put: { TableName: tableName(), Item: { ...ownerLink, id: record.id } } },
  );
  for (const group of new Set([...prev, ...next])) {
    const link = { PK: `WFGROUP#${group}`, SK: `DEF#${record.id}` };
    transact.push(
      next.has(group)
        ? { Put: { TableName: tableName(), Item: { ...link, id: record.id } } }
        : { Delete: { TableName: tableName(), Key: link } },
    );
  }
  try {
    await doc().send(new TransactWriteCommand({ TransactItems: transact }));
  } catch (e) {
    if (conditionalFailure(e))
      throw new WorkflowError(
        409,
        "This workflow changed in another session. Export your unsaved draft, then reload before editing.",
      );
    throw e;
  }
  return { ...flow, revision: row.revision, ownerId: row.owner };
}
export async function saveDefinition(
  user: Principal,
  id: string,
  input: unknown,
  expected: number,
) {
  const draft = parseDefinition(input);
  let old: DefinitionRecord | undefined, previous: Workflow | undefined;
  if (expected) {
    const loaded = await loadDefinition(user, id, "edit");
    old = loaded.record;
    previous = loaded.flow;
  }
  const flow: Workflow = {
    ...draft,
    id,
    createdBy: previous?.createdBy || user.name || user.email,
    version: previous?.version || 0,
    publishedAt: previous?.publishedAt,
    publishedGraph: previous?.publishedGraph,
    publishedApp: previous?.publishedApp,
    dirty: true,
    sharing: previous?.sharing || { visibility: "private", teams: [], permission: "run" },
    schedule: previous?.schedule || {
      ...draft.schedule,
      enabled: false,
      nextRun: undefined,
      lastRun: undefined,
      inputRunId: undefined,
    },
    updatedAt: now(),
  };
  return commitDefinition(
    old || {
      ...keyFor("DEF", id),
      id,
      owner: user.sub,
      revision: 0,
      key: "",
      sharing: flow.sharing,
    },
    flow,
    expected,
    old,
  );
}
export async function changeDefinition(
  user: Principal,
  id: string,
  expected: number,
  action: "publish" | "share" | "schedule" | "delete",
  value?: unknown,
) {
  const { record, flow } = await loadDefinition(user, id, "owner");
  if (expected !== record.revision)
    throw new WorkflowError(409, "The workflow changed. Reload before continuing.");
  if (action === "share") flow.sharing = validateSharing(value, user);
  if (action === "publish") {
    assertRunnable(flow);
    flow.version++;
    flow.publishedAt = now();
    flow.publishedGraph = structuredClone({ nodes: flow.nodes, edges: flow.edges });
    flow.publishedApp = structuredClone(flow.app);
    flow.dirty = false;
  }
  if (action === "schedule") {
    const input = value as Workflow["schedule"];
    // Reuse full definition parser to validate time zone, weekday and time fields.
    parseDefinition({ ...flow, schedule: input });
    if (typeof input.enabled !== "boolean")
      throw new WorkflowError(400, "Invalid schedule switch.");
    if (input.enabled) {
      if (!queueEnabled() || process.env.SW_WORKFLOWS_SCHEDULER_ENABLED !== "true")
        throw new WorkflowError(503, "The durable workflow scheduler is not configured.");
      if (!flow.publishedGraph) throw new WorkflowError(400, "Publish a reviewed version first.");
      if (!input.inputRunId)
        throw new WorkflowError(400, "Choose a previous run whose source inputs should be reused.");
      const source = await loadRun(user, input.inputRunId);
      if (source.record.principal.sub !== user.sub || source.record.workflowId !== id)
        throw new WorkflowError(403, "Use your own input run from this workflow.");
      assertRunnable(
        { ...flow, ...flow.publishedGraph, app: flow.publishedApp },
        source.run.inputs,
      );
    }
    flow.schedule = {
      enabled: input.enabled,
      frequency: input.frequency,
      time: input.time,
      timezone: input.timezone,
      days: input.days,
      inputRunId: input.inputRunId,
      nextRun: input.enabled ? nextScheduledRun(input) || undefined : undefined,
      lastRun: flow.schedule.lastRun,
    };
    record.scheduler = user;
  }
  if (action === "delete") {
    record.deleted = true;
    flow.schedule = { ...flow.schedule, enabled: false, nextRun: undefined };
  }
  flow.updatedAt = now();
  return commitDefinition(record, flow, expected, record, action === "publish");
}
export async function runRecord(id: string) {
  return (await getItem(keyFor("RUN", id).PK, "META", { consistent: true })) as
    | RunRecord
    | undefined;
}
export async function loadRun(user: Principal, id: string) {
  const record = await runRecord(id);
  if (!record) throw new WorkflowError(404, "Run not found.");
  const flow = await definitionRecord(record.workflowId);
  if (
    !flow ||
    !permission(user, flow) ||
    !canReadRun(user, record.owner, record.principal.sub, record.reviewers)
  )
    throw new WorkflowError(403, "You do not have access to this run’s documents.");
  return { record, run: await readJson<WorkflowRun>(record.key) };
}
export async function listRuns(user: Principal) {
  const links = (
    await Promise.all(
      [`WFRUNUSER#${user.sub}`, `WFRUNREVIEW#${user.email.toLowerCase()}`].map((p) =>
        queryPrefix(p, "RUN#", { limit: 30, scanForward: false }),
      ),
    )
  ).flat();
  const ids = [...new Set(links.map((l) => String(l.id)))];
  const rows: RunRecord[] = [];
  for (const id of ids) {
    const r = await runRecord(id);
    if (!r) continue;
    const f = await definitionRecord(r.workflowId);
    if (f && permission(user, f) && canReadRun(user, r.owner, r.principal.sub, r.reviewers))
      rows.push(r);
  }
  return rows
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
    .slice(0, 30)
    .map(
      (r) =>
        ({
          id: r.id,
          workflowId: r.workflowId,
          workflowName: r.workflowName,
          version: r.version,
          status: r.status,
          startedAt: r.startedAt,
          source: r.source,
          mode: "connected",
          graph: { nodes: [], edges: [] },
          inputs: { text: "", matter: "", selection: "", files: [] },
          results: {},
          logs: [],
          artifacts: [],
        }) as WorkflowRun,
    );
}
export async function enqueue(id: string) {
  if (!queueEnabled()) throw new WorkflowError(503, "The workflow worker queue is not configured.");
  await new SQSClient({ region: process.env.AWS_REGION || "us-east-1" }).send(
    new SendMessageCommand({
      QueueUrl: process.env.SW_WORKFLOWS_QUEUE_URL,
      MessageBody: JSON.stringify({ runId: id }),
    }),
  );
}
export async function startRun(
  user: Principal,
  workflowId: string,
  inputs: RunInputs,
  published: boolean,
  requestId: string,
  source: WorkflowRun["source"] = "manual",
) {
  if (!queueEnabled())
    throw new WorkflowError(
      503,
      "The workflow worker queue is not configured. No run was started.",
    );
  const { record: definition, flow } = await loadDefinition(user, workflowId, "run");
  if (!published) authorize(user, definition, "edit");
  if (published && !flow.publishedGraph)
    throw new WorkflowError(400, "Publish this workflow before running its published version.");
  const graph = published ? { ...flow, ...flow.publishedGraph!, app: flow.publishedApp } : flow;
  if (graph.app?.templateId === "page-monitor") {
    // Pin the baseline into this run's immutable inputs before any tool runs.
    inputs = { ...inputs, files: [] };
    const history = await queryPrefix(`WFRUNFLOW#${workflowId}#${user.sub}`, "RUN#", {
      limit: 30,
      scanForward: false,
    });
    for (const prior of history) {
      const metadata = await runRecord(String(prior.id));
      if (metadata?.status !== "completed") continue;
      const old = await loadRun(user, String(prior.id));
      if (old.record.principal.sub !== user.sub) continue;
      const snapshot = Object.values(old.run.results)
        .map((r) => r.output as { requestUrl?: string; files?: RunInputs["files"] } | undefined)
        .find((o) => o?.requestUrl === inputs.fields?.url && o?.files?.length);
      if (snapshot?.files?.length) {
        inputs.files = [
          { ...snapshot.files.at(-1)!, name: "Baseline — " + snapshot.files.at(-1)!.name },
        ];
        inputs.fields = { ...inputs.fields, baselineRunId: String(prior.id) };
        break;
      }
    }
  }
  assertRunnable(graph, inputs);
  const existing = await runRecord(requestId);
  if (existing) {
    if (existing.principal.sub !== user.sub || existing.workflowId !== workflowId)
      throw new WorkflowError(409, "Request identifier already used.");
    return (await loadRun(user, requestId)).run;
  }
  const run = createRun(graph, inputs, source, false);
  run.id = requestId;
  run.mode = "connected";
  const key = await writeJson("runs", run.id, run);
  const record: RunRecord = {
    ...keyFor("RUN", run.id),
    id: run.id,
    workflowId,
    owner: definition.owner,
    principal: user,
    reviewers: [
      ...new Set(
        graph.nodes
          .filter((n) => n.data.kind === "review")
          .map((n) => n.data.config.reviewer || "")
          .filter((e) => e.includes("@"))
          .map((e) => e.toLowerCase()),
      ),
    ],
    revision: 1,
    key,
    status: run.status,
    startedAt: run.startedAt,
    workflowName: run.workflowName,
    version: run.version,
    source,
    requiredAccess: published ? "run" : "edit",
    GSI1PK: "WF_RUN_DUE",
    GSI1SK: `${now()}#${run.id}`,
  };
  const links = [
    ...new Set([
      `WFRUNUSER#${user.sub}`,
      `WFRUNFLOW#${workflowId}#${user.sub}`,
      `WFRUNUSER#${definition.owner}`,
      ...record.reviewers.map((e) => `WFRUNREVIEW#${e}`),
    ]),
  ];
  const day = new Date().toISOString().slice(0, 10);
  const configuredLimit = Number(process.env.SW_WORKFLOWS_DAILY_RUN_LIMIT || 20);
  const limit =
    Number.isInteger(configuredLimit) && configuredLimit > 0 ? Math.min(configuredLimit, 200) : 20;
  try {
    await doc().send(
      new TransactWriteCommand({
        TransactItems: [
          {
            ConditionCheck: {
              TableName: tableName(),
              Key: keyFor("DEF", workflowId),
              ConditionExpression: "revision = :r AND attribute_not_exists(deleted)",
              ExpressionAttributeValues: { ":r": definition.revision },
            },
          },
          {
            Put: {
              TableName: tableName(),
              Item: record,
              ConditionExpression: "attribute_not_exists(PK)",
            },
          },
          {
            Update: {
              TableName: tableName(),
              Key: { PK: `WFQUOTA#${user.sub}`, SK: day },
              UpdateExpression: "SET #ttl = :ttl ADD #count :one",
              ConditionExpression: "attribute_not_exists(#count) OR #count < :limit",
              ExpressionAttributeNames: { "#count": "count", "#ttl": "ttl" },
              ExpressionAttributeValues: {
                ":one": 1,
                ":limit": limit,
                ":ttl": Math.floor(Date.now() / 1000) + 172800,
              },
            },
          },
          ...links.map((PK) => ({
            Put: {
              TableName: tableName(),
              Item: { PK, SK: `RUN#${run.startedAt}#${run.id}`, id: run.id },
            },
          })),
        ],
      }),
    );
  } catch (e) {
    if (conditionalFailure(e))
      throw new WorkflowError(
        409,
        "The workflow changed, the request already started, or your daily run limit was reached. Reload run history before retrying.",
      );
    throw e;
  }
  // The due index is the outbox. A queue interruption leaves a recoverable, visible run.
  try {
    await enqueue(run.id);
  } catch {
    run.logs.push({
      id: crypto.randomUUID(),
      time: now(),
      level: "warning",
      message: "Run is saved; queue delivery is pending scheduler recovery.",
    });
  }
  return run;
}
export async function saveRun(record: RunRecord, run: WorkflowRun, patch: Partial<RunRecord> = {}) {
  const key = await writeJson("runs", run.id, run);
  let due: string | undefined;
  if (run.status === "running") due = new Date(patch.leaseUntil || Date.now()).toISOString();
  if (run.status === "waiting")
    due = run.graph.nodes
      .filter((n) => n.data.kind === "delay" && run.results[n.id]?.status === "waiting")
      .map((n) => run.results[n.id]?.resumeAt)
      .filter(Boolean)
      .sort()[0];
  const next: RunRecord = {
    ...record,
    ...patch,
    key,
    revision: record.revision + 1,
    status: run.status,
    GSI1PK: due ? "WF_RUN_DUE" : undefined,
    GSI1SK: due ? `${due}#${run.id}` : undefined,
  };
  try {
    await doc().send(
      new PutCommand({
        TableName: tableName(),
        Item: next,
        ConditionExpression: "revision = :r",
        ExpressionAttributeValues: { ":r": record.revision },
      }),
    );
  } catch (e) {
    if (conditionalFailure(e))
      throw new WorkflowError(
        409,
        "The run changed during this action. Reload its current status.",
      );
    throw e;
  }
  return next;
}
export async function actOnRun(
  user: Principal,
  id: string,
  action: "cancel" | "review",
  approved?: boolean,
  notes = "",
) {
  const { record, run } = await loadRun(user, id);
  if (action === "cancel") {
    if (user.sub !== record.owner && user.sub !== record.principal.sub)
      throw new WorkflowError(403, "Only the owner or submitter can cancel this run.");
    if (!["running", "waiting"].includes(run.status))
      throw new WorkflowError(409, "This run has already ended.");
    run.status = "cancelled";
    run.endedAt = now();
    run.logs.push({
      id: crypto.randomUUID(),
      time: now(),
      message: `Cancelled by ${user.email}.`,
      level: "warning",
    });
    await saveRun(record, run, { cancelRequested: true, lease: undefined, leaseUntil: undefined });
  } else {
    if (!canReview(user, record.owner, run))
      throw new WorkflowError(
        403,
        "This review is assigned to a different person or is no longer pending.",
      );
    const updated = reviewRun(run, approved === true, user.email, notes);
    await saveRun(record, updated, { lease: undefined, leaseUntil: undefined });
    if (approved) await enqueue(id);
    return updated;
  }
  return run;
}
export async function readWorkerRun(record: RunRecord) {
  return readJson<WorkflowRun>(record.key);
}
export async function dueRecords(
  index: "GSI1" | "GSI2",
  partition: string,
): Promise<Record<string, unknown>[]> {
  const result = await doc().send(
    new QueryCommand({
      TableName: tableName(),
      IndexName: index,
      KeyConditionExpression: "#pk = :pk AND #sk <= :now",
      ExpressionAttributeNames: { "#pk": `${index}PK`, "#sk": `${index}SK` },
      ExpressionAttributeValues: { ":pk": partition, ":now": `${now()}#~` },
      Limit: 100,
    }),
  );
  return result.Items || [];
}
export async function scheduledTick() {
  if (!configured() || !queueEnabled()) return;
  let failures = 0;
  for (const entry of await dueRecords("GSI1", "WF_RUN_DUE")) {
    try {
      await enqueue(String(entry.id));
    } catch (error) {
      failures++;
      console.error("Workflow outbox delivery failed", {
        runId: entry.id,
        errorType: error instanceof Error ? error.name : "Unknown",
      });
    }
  }
  for (const entry of await dueRecords("GSI2", "WF_SCHEDULE")) {
    const record = await definitionRecord(String(entry.id));
    if (!record || record.deleted || !record.scheduler) continue;
    try {
      const scheduler = await refreshWorkerPrincipal(record.scheduler);
      const { flow } = await loadDefinition(scheduler, record.id, "owner");
      if (
        !flow.schedule.enabled ||
        !flow.schedule.nextRun ||
        Date.parse(flow.schedule.nextRun) > Date.now()
      )
        continue;
      const input = await loadRun(scheduler, flow.schedule.inputRunId!);
      const hash = createHash("sha256")
        .update(`${record.id}:${flow.schedule.nextRun}`)
        .digest("hex");
      const runId = `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-8${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
      await startRun(scheduler, record.id, input.run.inputs, true, runId, "schedule");
      flow.schedule = {
        ...flow.schedule,
        lastRun: now(),
        nextRun: nextScheduledRun(flow.schedule) || undefined,
        lastError: undefined,
        lastErrorAt: undefined,
        retryAt: undefined,
      };
      await commitDefinition(record, flow, record.revision, record);
    } catch (error) {
      failures++;
      console.error("Workflow schedule attempt failed", {
        workflowId: record.id,
        errorType: error instanceof Error ? error.name : "Unknown",
      });
      // Preserve the occurrence time (and its idempotency key) while backing off this one schedule.
      // Never overwrite an owner's concurrent schedule edit.
      try {
        const latest = await definitionRecord(record.id);
        if (latest?.revision !== record.revision || latest.deleted) continue;
        const flow = await readJson<Workflow>(latest.key);
        const permanent =
          error instanceof WorkflowError && [400, 403, 404, 422].includes(error.status);
        flow.schedule = {
          ...flow.schedule,
          enabled: permanent ? false : flow.schedule.enabled,
          lastError:
            error instanceof WorkflowError
              ? error.message
              : "A service is unavailable. The scheduler will retry this occurrence.",
          lastErrorAt: now(),
          retryAt: permanent ? undefined : new Date(Date.now() + 300000).toISOString(),
        };
        await commitDefinition(latest, flow, latest.revision, latest);
      } catch (saveError) {
        console.error("Workflow schedule failure status could not be saved", {
          workflowId: record.id,
          errorType: saveError instanceof Error ? saveError.name : "Unknown",
        });
      }
    }
  }
  if (failures)
    throw new Error(
      `${failures} workflow dispatches need attention. Other due workflows were still processed.`,
    );
}
