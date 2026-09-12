// Test-only entry; served by Playwright interception, never added to app routes.
import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { ColumnSuggestionsDialog } from "../../src/components/docs/review/ColumnSuggestionsDialog";
import {
  sampleReviewDocuments,
  validateColumnSuggestions,
  type ColumnSuggestion,
} from "../../src/lib/review/column-suggestions";
import { discoveryRequest } from "../../src/lib/pile/discovery-scan";
import "../../src/styles.css";

export function ColumnHarness() {
  const [open, setOpen] = useState(true);
  const [columns, setColumns] = useState<ColumnSuggestion[]>([]);
  return (
    <main className="bg-slate-50 p-8">
      <h1>Review test fixture</h1>
      <button onClick={() => setOpen(true)}>Suggest columns</button>
      <output aria-label="Added columns">
        {columns.map((c) => `${c.name}: ${c.question}`).join("\n")}
      </output>
      <ColumnSuggestionsDialog
        open={open}
        onOpenChange={setOpen}
        remaining={8}
        onAdd={async (cols) => setColumns(cols)}
        onGenerate={async (objective, signal) => {
          const files = [
            { id: "a", name: "Safety memo.txt", pageCount: 1 },
            { id: "b", name: "Deposition.txt", pageCount: 1 },
          ];
          const sample = sampleReviewDocuments(
            files,
            files.map((f) => ({
              fileId: f.id,
              fileName: f.name,
              page: 1,
              ocr: false,
              text: `Test-only source ${f.name}: a witness described receiving notice in May.`,
            })),
          );
          const raw = await discoveryRequest(
            { action: "columns", query: objective, context: sample.context, existing: [] },
            signal,
          );
          return { sample, suggestions: validateColumnSuggestions(raw, []) };
        }}
      />
    </main>
  );
}
createRoot(document.getElementById("root")!).render(<ColumnHarness />);
