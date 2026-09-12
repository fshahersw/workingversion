import assert from "node:assert/strict";
import { test } from "node:test";
import {
  planScan,
  runDocumentScan,
  validateScanResult,
  retryScan,
  documentOrientation,
  type ScanWindowResult,
} from "./discovery-scan.ts";
import type { PilePage } from "./types.ts";
import { HttpStatusError } from "./async.ts";

const page = (fileId: string, n: number, text: string): PilePage => ({
  fileId,
  fileName: `${fileId}.txt`,
  page: n,
  text,
  ocr: false,
});
test("scan windows cover the end of long pages and every selected document", () => {
  const text = "begin ".repeat(400) + "LAST-EVIDENCE";
  const windows = planScan(
    [page("a", 1, text), page("b", 1, "other testimony"), page("excluded", 1, "secret")],
    [
      { id: "a", name: "a.txt", pageCount: 1 },
      { id: "b", name: "b.txt", pageCount: 1 },
    ],
    1000,
  );
  assert.ok(windows.some((w) => w.pages.some((p) => p.text.endsWith("LAST-EVIDENCE"))));
  assert.equal(windows.at(-1)?.fileId, "b");
  assert.ok(windows.every((w) => w.pages.reduce((n, p) => n + p.text.length, 0) <= 1000));
  const joined = windows
    .filter((w) => w.fileId === "a")
    .flatMap((w) => w.pages)
    .map((p, i) => (i ? p.text.slice(300) : p.text))
    .join("");
  assert.equal(joined, text);
});
test("invalid quotes and wrong pages fail coverage closed", () => {
  const result = validateScanResult(
    {
      complete: true,
      findings: [
        { finding: "Claim", page: 1, quote: "Fabricated responsive quote" },
        { finding: "Wrong page", page: 2, quote: "The meeting was canceled." },
      ],
    },
    [{ page: 1, text: "The meeting was canceled." }],
  );
  assert.equal(result.complete, false);
  assert.deepEqual(result.findings, []);
  assert.throws(() => validateScanResult({ findings: [] }, []), /invalid/);
});
test("all-document scan retains nonmatching files, missing pages, and end-page evidence", async () => {
  const calls: string[] = [];
  const result = await runDocumentScan({
    query: "Who knew?",
    files: [
      { id: "a", name: "a.txt", pageCount: 2 },
      { id: "b", name: "b.txt", pageCount: 1 },
    ],
    pages: [
      page("a", 1, ""),
      page("a", 2, "We knew about the risk."),
      page("b", 1, "Routine correspondence."),
    ],
    cache: new Map(),
    synthesize: false,
    request: async (w) => {
      calls.push(w.fileId);
      return {
        complete: true,
        findings:
          w.fileId === "a"
            ? [{ finding: "Knowledge of risk", quote: "We knew about the risk.", page: 2 }]
            : [],
      };
    },
  });
  assert.deepEqual(calls.sort(), ["a", "b"]);
  assert.equal(result.coverage.files[0]?.missingPages, 1);
  assert.equal(result.evidence[0]?.page, 2);
  assert.match(result.answer, /Partial coverage/);
  assert.match(result.answer, /b\.txt/);
  assert.match(result.answer, /No source-linked findings returned/);
});
test("retry reuses successful windows only; changing context invalidates them", async () => {
  const cache = new Map<string, ScanWindowResult>();
  let fail = true;
  let calls = 0;
  const opts = {
    query: "Question",
    instructions: "Notice",
    files: [
      { id: "a", name: "a.txt", pageCount: 1 },
      { id: "b", name: "b.txt", pageCount: 1 },
    ],
    pages: [page("a", 1, "Valid source A."), page("b", 1, "Valid source B.")],
    cache,
    synthesize: false,
    request: async (w: { fileId: string }) => {
      calls++;
      if (w.fileId === "b" && fail) throw new Error("Reader unavailable");
      return { findings: [], complete: true };
    },
  };
  const first = await runDocumentScan(opts);
  assert.equal(first.coverage.failedWindows, 1);
  fail = false;
  const second = await runDocumentScan(opts);
  assert.equal(calls, 3);
  assert.equal(second.coverage.reusedWindows, 1);
  assert.equal(second.coverage.completedWindows, 2);
  await runDocumentScan({ ...opts, instructions: "Different objective" });
  assert.equal(calls, 5);
});
test("authentication failures stop scans instead of creating per-document false negatives", async () => {
  await assert.rejects(
    runDocumentScan({
      query: "q",
      files: [{ id: "a", name: "a.txt", pageCount: 1 }],
      pages: [page("a", 1, "some source")],
      cache: new Map(),
      synthesize: false,
      request: async () => {
        throw new HttpStatusError(401, "Sign in");
      },
    }),
    /Sign in/,
  );
});
test("cancelled scans never cache the in-flight result", async () => {
  const controller = new AbortController();
  const cache = new Map();
  await assert.rejects(
    runDocumentScan({
      query: "q",
      files: [{ id: "a", name: "a.txt", pageCount: 1 }],
      pages: [page("a", 1, "some source")],
      cache,
      signal: controller.signal,
      synthesize: false,
      request: async () => {
        controller.abort();
        return { complete: true, findings: [] };
      },
    }),
    { name: "AbortError" },
  );
  assert.equal(cache.size, 0);
});

test("retry policy respects permanent failures and bounded recoverable attempts", async () => {
  let calls = 0;
  await assert.rejects(
    retryScan(async () => {
      calls++;
      throw new HttpStatusError(400, "Invalid scope");
    }),
    /Invalid scope/,
  );
  assert.equal(calls, 1);
  calls = 0;
  const result = await retryScan(async () => {
    calls++;
    if (calls < 3) throw new HttpStatusError(503, "Temporary failure", 1);
    return "recovered";
  });
  assert.equal(result, "recovered");
  assert.equal(calls, 3);
});

test("document orientation is bounded and never validates a quote absent from the scan section", () => {
  const pages = [
    { page: 1, text: "Caption identifies Jane Smith. " + "x".repeat(10_000) },
    { page: 2, text: "Answer in the later section." },
  ];
  assert.ok(documentOrientation(pages).length < 6000);
  const result = validateScanResult(
    {
      complete: true,
      findings: [{ finding: "Witness identity", quote: "Caption identifies Jane Smith.", page: 1 }],
    },
    [pages[1]!],
  );
  assert.equal(result.complete, false);
  assert.equal(result.findings.length, 0);
});
