import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

function source(relativeUrl: string): string {
  return readFileSync(new URL(relativeUrl, import.meta.url), "utf8");
}

function serverFnBlock(contents: string, name: string): string {
  const start = contents.indexOf(`export const ${name} =`);
  assert.notEqual(start, -1, `missing server function ${name}`);
  const next = contents.indexOf("\nexport const ", start + 1);
  return contents.slice(start, next === -1 ? undefined : next);
}

function assertMiddleware(contents: string, names: string[], middleware: string): void {
  for (const name of names) {
    assert.match(
      serverFnBlock(contents, name),
      new RegExp(String.raw`\.middleware\(\[${middleware}\]\)`),
      `${name} must use ${middleware}`,
    );
  }
}

test("firm-shared server function reads require Cognito authentication", () => {
  const workspace = source("../workspace.functions.ts");
  assertMiddleware(
    workspace,
    [
      "getMatters",
      "getMatterWorkspace",
      "getMatterEntries",
      "getMatterDocuments",
      "getEntryDocuments",
      "getDocumentViewUrl",
      "getPipelineRuns",
    ],
    "requireAuth",
  );

  const summaries = source("../summaries.functions.ts");
  assertMiddleware(
    summaries,
    ["listDocSummaries", "getDocSummary", "getSummarySourceUrl"],
    "requireAuth",
  );

  const intel = source("../intel.functions.ts");
  assertMiddleware(intel, ["getIntelFeed", "getIntelStatus", "getCorpusSignals"], "requireAuth");

  const calendar = source("../calendar.functions.ts");
  assertMiddleware(calendar, ["getCorpusCalendar"], "requireAuth");
});

test("firm-global upload and summary writes require Cognito admin", () => {
  const workspace = source("../workspace.functions.ts");
  assertMiddleware(workspace, ["getUploadUrls"], "requireAdmin");

  const summaries = source("../summaries.functions.ts");
  assertMiddleware(
    summaries,
    ["deleteDocSummary", "saveDocSummary", "getSummaryUploadUrls"],
    "requireAdmin",
  );
});

test("pipeline server functions use Cognito admin context only", () => {
  const pipeline = source("../pipeline.functions.ts");
  assertMiddleware(
    pipeline,
    [
      "getPipelineOverview",
      "runPipelineSelfTest",
      "checkPipelineAccess",
      "runIntelRefresh",
      "getDocketWatchOverview",
    ],
    "requireAdmin",
  );
  assert.doesNotMatch(pipeline, /supabase/i);
  assert.match(serverFnBlock(pipeline, "getPipelineOverview"), /context\.user\.email/);
});

test("the HTTP auth gate preserves public route self-authentication", () => {
  const start = source("../../start.ts");
  assert.match(start, /pathname\.startsWith\("\/api\/"\)/);
  assert.match(start, /!pathname\.startsWith\("\/api\/public\/"\)/);
  assert.match(start, /requestMiddleware:\s*\[errorMiddleware,\s*apiAuthMiddleware\]/);
});
