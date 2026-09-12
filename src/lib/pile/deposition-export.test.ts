import assert from "node:assert/strict";
import { test } from "node:test";
import { EMPTY_ANALYSIS, type DepAnalysis } from "./deposition-analysis.ts";
import {
  depositionExportCsv,
  depositionExportMarkdown,
  depositionExportRows,
  exportCsvValue,
} from "./deposition-export.ts";
test("selective exports contain only the selected findings and keep provenance", () => {
  const analysis: DepAnalysis = {
    ...structuredClone(EMPTY_ANALYSIS),
    summary: "Do not export this summary",
    chronology: [
      {
        id: "c",
        date: "2025-01-01",
        title: "Notice",
        summary: "Receipt",
        quote: "I received the warning.",
        cite: "12:4-12:7",
        fileName: "Smith.txt",
        evidenceStatus: "source_matched",
      },
    ],
  };
  const rows = depositionExportRows(analysis, ["chronology"]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.source, "Smith.txt");
  assert.equal(rows[0]?.cite, "12:4-12:7");
  const markdown = depositionExportMarkdown(analysis, ["chronology"], "Smith", false);
  assert.match(markdown, /PARTIAL ANALYSIS/);
  assert.doesNotMatch(markdown, /Do not export this summary/);
  assert.match(depositionExportCsv(analysis, ["chronology"]), /source_matched/);
  assert.match(depositionExportCsv(analysis, ["chronology"], false), /PARTIAL ANALYSIS/);
});
test("potential-conflict export keeps both independent witnesses and sources", () => {
  const analysis: DepAnalysis = {
    ...structuredClone(EMPTY_ANALYSIS),
    contradictions: [
      {
        id: "c",
        title: "Notice timing",
        summary: "Compare accounts",
        tags: [],
        a: {
          witness: "Smith",
          fileName: "Smith.txt",
          quote: "I was told in May",
          cite: "3:4",
          evidenceStatus: "source_matched",
        },
        b: {
          witness: "Jones",
          fileName: "Jones.txt",
          quote: "I was told in June",
          cite: "7:8",
          evidenceStatus: "needs_review",
        },
      },
    ],
  };
  const rows = depositionExportRows(analysis, ["contradictions"]);
  assert.equal(rows.length, 2);
  assert.equal(rows[1]?.evidence, "needs_review");
  assert.equal(rows[1]?.source, "Jones.txt");
});
test("spreadsheet exports neutralize formulas and preserve quotes", () => {
  assert.equal(exportCsvValue('=HYPERLINK("url")'), '"\'=HYPERLINK(""url"")"');
  assert.equal(exportCsvValue("ordinary text"), '"ordinary text"');
});
