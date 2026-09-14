// Unit tests for the no-BDA background text-ingest orchestrator. Pure: the AWS
// dependencies (Aurora, S3, SQS, embed) are injected, so this runs under
//   node --experimental-strip-types --test src/lib/kb/ingest-text.server.test.ts
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  createTextIngestOrchestrator,
  parseTextIngestMessage,
  type TextIngestDependencies,
  type TextIngestMessage,
} from "./ingest-text.server.ts";

const OWNER = "a4b8a498-5011-708a-c68f-fe0d7974936e";
const ITEM = "2ddcd40b-5650-4581-a310-82b68d4446d9";
const CLIENT_FILE = "3ebec04c-3a9c-443c-8f54-0b739aee30d2";
const DOC = "871812d5-8130-463d-8d9e-2a4980b9d772";

type DocState = {
  doc_id: string;
  owner_sub: string;
  workspace_id: string;
  surface: "workingset" | "deposition" | "review";
  file_name: string;
  mime: string | null;
  sha256: string | null;
  byte_size: number | null;
  page_count: number | null;
  s3_key: string | null;
  converter: string | null;
  status: "queued" | "converting" | "embedding" | "ready" | "error";
  bda_invocation_arn: null;
  bda_input_key: null;
  bda_output_prefix: null;
  bda_output_s3_uri: null;
  bda_client_file_id: null;
};

function doc(overrides: Partial<DocState> = {}): DocState {
  return {
    doc_id: DOC,
    owner_sub: OWNER,
    workspace_id: ITEM,
    surface: "workingset",
    file_name: "brief.pdf",
    mime: "application/pdf",
    sha256: "a".repeat(64),
    byte_size: 1234,
    page_count: 400,
    s3_key: `kb/pages/${OWNER}/${DOC}.json`,
    converter: "client-text",
    status: "queued",
    bda_invocation_arn: null,
    bda_input_key: null,
    bda_output_prefix: null,
    bda_output_s3_uri: null,
    bda_client_file_id: null,
    ...overrides,
  };
}

type Recorder = {
  inserted: unknown[];
  puts: unknown[];
  processed: unknown[];
  checkpoints: { status: string; docId?: string; pagesKey?: string; errorKind?: string }[];
  updates: { patch: Record<string, unknown> }[];
  finalized: number;
  enqueued: TextIngestMessage[];
};

function makeDeps(
  initialDoc: DocState | null,
  over: Partial<TextIngestDependencies> = {},
): { deps: TextIngestDependencies; rec: Recorder; docRef: { current: DocState | null } } {
  const rec: Recorder = {
    inserted: [],
    puts: [],
    processed: [],
    checkpoints: [],
    updates: [],
    finalized: 0,
    enqueued: [],
  };
  const docRef = { current: initialDoc };
  const deps: TextIngestDependencies = {
    insertDocument: async (_sub, input) => {
      rec.inserted.push(input);
      docRef.current = doc({ status: "queued", page_count: input.pageCount ?? null });
      return DOC;
    },
    getDocument: async () => docRef.current,
    updateDocument: async (_sub, _docId, patch) => {
      rec.updates.push({ patch: patch as Record<string, unknown> });
      if (docRef.current && patch.status) {
        docRef.current = { ...docRef.current, status: patch.status };
      }
      return true;
    },
    putPages: async (_sub, docId) => {
      const key = `kb/pages/${OWNER}/${docId}.json`;
      rec.puts.push(key);
      return key;
    },
    getPages: async () => [{ page: 1, text: "hello world" }],
    toCanonical: (pages, meta) =>
      ({ fileName: meta.fileName, pageCount: pages.length, pages: [] }) as never,
    processExisting: async (_sub, args) => {
      rec.processed.push(args);
      if (docRef.current) docRef.current = { ...docRef.current, status: "ready" };
      return { docId: args.docId, chunkCount: 7, pageCount: 400 };
    },
    checkpoint: async (_sub, patch) => {
      rec.checkpoints.push({
        status: patch.status,
        ...(patch.docId ? { docId: patch.docId } : {}),
        ...(patch.pagesKey ? { pagesKey: patch.pagesKey } : {}),
        ...(patch.errorKind ? { errorKind: patch.errorKind } : {}),
      });
    },
    finalizeWorkspace: async () => {
      rec.finalized += 1;
    },
    enqueue: async (message) => {
      rec.enqueued.push(message);
    },
    ...over,
  };
  return { deps, rec, docRef };
}

test("register inserts a queued doc, stores pages, checkpoints the key, then enqueues", async () => {
  const { deps, rec } = makeDeps(null);
  const orch = createTextIngestOrchestrator(deps);
  const res = await orch.register({
    ownerSub: OWNER,
    workspaceItemId: ITEM,
    workspaceId: ITEM,
    clientFileId: CLIENT_FILE,
    fileName: "brief.pdf",
    surface: "workingset",
    mime: "application/pdf",
    sha256: "b".repeat(64),
    byteSize: 1234,
    pages: [
      { page: 1, text: "alpha" },
      { page: 2, text: "  " }, // blank page is dropped
      { page: 3, text: "beta" },
    ],
  });
  assert.equal(res.status, "queued");
  assert.equal(rec.inserted.length, 1);
  assert.equal((rec.inserted[0] as { pageCount: number }).pageCount, 2, "blank page not counted");
  assert.equal((rec.inserted[0] as { status: string }).status, "queued");
  assert.equal(rec.puts.length, 1);
  // The checkpoint carrying the pages key must precede the enqueue so the worker
  // can always read the pages it is told to embed.
  const cp = rec.checkpoints[0]!;
  assert.equal(cp.status, "embedding");
  assert.equal(cp.pagesKey, `kb/pages/${OWNER}/${DOC}.json`);
  assert.equal(rec.enqueued.length, 1);
  assert.deepEqual(
    { kind: rec.enqueued[0]!.kind, docId: rec.enqueued[0]!.docId, ownerSub: rec.enqueued[0]!.ownerSub },
    { kind: "text", docId: DOC, ownerSub: OWNER },
  );
});

test("register refuses a document with no extractable text", async () => {
  const { deps } = makeDeps(null);
  const orch = createTextIngestOrchestrator(deps);
  await assert.rejects(
    orch.register({
      ownerSub: OWNER,
      workspaceItemId: ITEM,
      workspaceId: ITEM,
      clientFileId: CLIENT_FILE,
      fileName: "scan.pdf",
      surface: "workingset",
      pages: [{ page: 1, text: "   " }],
    }),
    /at least one page/,
  );
});

const message: TextIngestMessage = {
  version: 1,
  kind: "text",
  ownerSub: OWNER,
  docId: DOC,
  workspaceItemId: ITEM,
  workspaceId: ITEM,
  clientFileId: CLIENT_FILE,
  surface: "workingset",
  correlationId: `text-${DOC}`,
};

test("handle embeds a queued doc and finalizes the workspace", async () => {
  const { deps, rec } = makeDeps(doc({ status: "queued" }));
  const orch = createTextIngestOrchestrator(deps);
  const out = await orch.handle(message);
  assert.equal(out.status, "processed");
  assert.equal(rec.processed.length, 1);
  assert.equal((rec.processed[0] as { converter: string }).converter, "client-text");
  assert.equal(rec.checkpoints.at(-1)!.status, "ready");
  assert.equal(rec.finalized, 1);
});

test("handle is idempotent when the doc is already ready (no re-embed)", async () => {
  const { deps, rec } = makeDeps(doc({ status: "ready" }));
  const orch = createTextIngestOrchestrator(deps);
  const out = await orch.handle(message);
  assert.equal(out.status, "duplicate");
  assert.equal(rec.processed.length, 0, "ready doc is not re-embedded");
  assert.equal(rec.finalized, 1, "still re-finalizes so the set can settle");
});

test("handle drops a message whose doc is missing or cross-tenant (RLS mismatch)", async () => {
  const missing = makeDeps(null);
  assert.equal((await createTextIngestOrchestrator(missing.deps).handle(message)).status, "duplicate");
  assert.equal(missing.rec.processed.length, 0);

  const wrongWorkspace = makeDeps(doc({ workspace_id: "99999999-0000-0000-0000-000000000000" }));
  assert.equal(
    (await createTextIngestOrchestrator(wrongWorkspace.deps).handle(message)).status,
    "duplicate",
  );
  assert.equal(wrongWorkspace.rec.processed.length, 0);
});

test("handle fails closed when the pages object is empty (marks error, finalizes)", async () => {
  const { deps, rec } = makeDeps(doc({ status: "queued" }), {
    getPages: async () => [],
  });
  const orch = createTextIngestOrchestrator(deps);
  const out = await orch.handle(message);
  assert.equal(out.status, "processed");
  assert.equal(rec.processed.length, 0);
  assert.equal(rec.updates.at(-1)!.patch["status"], "error");
  assert.equal(rec.checkpoints.at(-1)!.status, "error");
  assert.equal(rec.finalized, 1);
});

test("handle records a bounded error kind when embedding throws", async () => {
  const { deps, rec } = makeDeps(doc({ status: "queued" }), {
    processExisting: async () => {
      throw new Error("titan throttled after retries");
    },
  });
  const orch = createTextIngestOrchestrator(deps);
  const out = await orch.handle(message);
  assert.equal(out.status, "processed");
  assert.equal(rec.checkpoints.at(-1)!.status, "error");
  assert.equal(rec.checkpoints.at(-1)!.errorKind, "processing");
  assert.equal(rec.finalized, 1);
});

test("parseTextIngestMessage accepts a valid message and rejects malformed ones", () => {
  assert.deepEqual(parseTextIngestMessage(JSON.stringify(message)), message);
  assert.throws(() => parseTextIngestMessage("{"), /invalid text ingest message/);
  assert.throws(
    () => parseTextIngestMessage({ ...message, kind: "bda" }),
    /invalid text ingest message/,
  );
  assert.throws(
    () => parseTextIngestMessage({ ...message, surface: "nope" }),
    /invalid text ingest message/,
  );
  assert.throws(
    () => parseTextIngestMessage({ ...message, ownerSub: "not-a-uuid!" }),
    /invalid text ingest message/,
  );
});
