import assert from "node:assert/strict";
import { test } from "node:test";

import { processExistingCanonicalDoc } from "./ingest.server.ts";
import type { KbDocumentRecord } from "./aurora.server.ts";

const docId = "123e4567-e89b-42d3-a456-426614174333";
const workspaceId = "123e4567-e89b-42d3-a456-426614174222";
const canonical = {
  docId,
  fileName: "synthetic.pdf",
  pageCount: 1,
  pages: [
    {
      pageNo: 1,
      source: "bda" as const,
      blocks: [{ kind: "para" as const, text: "Synthetic fixture text." }],
    },
  ],
};

function row(status: KbDocumentRecord["status"]): KbDocumentRecord {
  return {
    doc_id: docId,
    owner_sub: "synthetic-owner",
    workspace_id: workspaceId,
    surface: "workingset",
    file_name: "synthetic.pdf",
    mime: "application/pdf",
    sha256: "a".repeat(64),
    byte_size: 100,
    page_count: 1,
    s3_key: null,
    converter: "bda",
    status,
    bda_invocation_arn: null,
    bda_input_key: null,
    bda_output_prefix: null,
    bda_output_s3_uri: null,
    bda_client_file_id: null,
  };
}

test("existing-document ingest atomically replaces chunks without inserting a document", async () => {
  let replaces = 0;
  const statuses: string[] = [];
  const result = await processExistingCanonicalDoc(
    "synthetic-owner",
    {
      docId,
      workspaceId,
      surface: "workingset",
      doc: canonical,
      converter: "bda",
    },
    {
      getDocument: async () => row("converting"),
      chunk: () => [
        {
          chunkIndex: 0,
          pageStart: 1,
          pageEnd: 1,
          kind: "para",
          content: "Synthetic fixture text.",
          headingPath: "",
          tokenCount: 6,
        },
      ],
      embed: async () => [
        {
          chunkIndex: 0,
          pageStart: 1,
          pageEnd: 1,
          kind: "para",
          content: "Synthetic fixture text.",
          embedding: [0.1],
        },
      ],
      replaceChunks: async () => {
        replaces += 1;
      },
      updateIngest: async (_sub, _docId, patch) => {
        if (patch.status) statuses.push(patch.status);
        return true;
      },
    },
  );
  assert.deepEqual(result, { docId, chunkCount: 1, pageCount: 1 });
  assert.equal(replaces, 1);
  assert.deepEqual(statuses, ["embedding", "ready"]);
});

test("ready existing documents are idempotent no-op replays", async () => {
  let embeds = 0;
  const result = await processExistingCanonicalDoc(
    "synthetic-owner",
    {
      docId,
      workspaceId,
      surface: "workingset",
      doc: canonical,
    },
    {
      getDocument: async () => row("ready"),
      chunk: () => [
        {
          chunkIndex: 0,
          pageStart: 1,
          pageEnd: 1,
          kind: "para",
          content: "Synthetic fixture text.",
          headingPath: "",
          tokenCount: 6,
        },
      ],
      embed: async () => {
        embeds += 1;
        return [];
      },
    },
  );
  assert.equal(result.chunkCount, 1);
  assert.equal(embeds, 0);
});

test("worker-deferred limit failures do not bypass the job lease to mark Aurora", async () => {
  let updates = 0;
  await assert.rejects(
    () =>
      processExistingCanonicalDoc(
        "synthetic-owner",
        {
          docId,
          workspaceId,
          surface: "workingset",
          doc: canonical,
          maxChunks: 0,
          deferFailure: true,
        },
        {
          getDocument: async () => row("embedding"),
          chunk: () => [
            {
              chunkIndex: 0,
              pageStart: 1,
              pageEnd: 1,
              kind: "para",
              content: "Synthetic fixture text.",
              headingPath: "",
              tokenCount: 6,
            },
          ],
          updateIngest: async () => {
            updates += 1;
            return true;
          },
        },
      ),
    /asynchronous ingest limits/i,
  );
  assert.equal(updates, 0);
});
