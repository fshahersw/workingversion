import type { PilePage } from "../pile/types.ts";
import { COLUMN_KINDS, type ColumnKind } from "./types.ts";

export type ColumnSuggestion = {
  name: string;
  kind: ColumnKind;
  question: string;
  options: string[];
  reason: string;
};
export type DocumentSample = {
  context: string;
  files: number;
  sampledPages: number;
  totalPages: number;
};

/** Distributed samples from every document; never silently drop the last documents. */
export function sampleReviewDocuments(
  files: { id: string; name: string; pageCount: number }[],
  pages: PilePage[],
  budget = 60_000,
): DocumentSample {
  if (!files.length) throw new Error("Add documents before suggesting columns");
  const available = files.map((file) => ({
    file,
    pages: pages
      .filter((p) => p.fileId === file.id && p.text.trim())
      .sort((a, b) => a.page - b.page),
  }));
  const missing = available.filter((f) => !f.pages.length);
  if (missing.length)
    throw new Error(
      `Text is unavailable for ${missing.length} document(s). Finish loading or OCR before generating columns.`,
    );
  const allocation = Math.floor(
    (budget - files.reduce((n, f) => n + f.name.length + 150, 0)) / files.length,
  );
  if (allocation < 240)
    throw new Error("Select a smaller document set for meaningful column suggestions");
  let sampledPages = 0;
  const context = available
    .map(({ file, pages: own }) => {
      const indexes = [...new Set([0, Math.floor((own.length - 1) / 2), own.length - 1])];
      const perPage = Math.max(1, Math.floor((allocation - indexes.length * 40) / indexes.length));
      sampledPages += indexes.length;
      return (
        `DOCUMENT ${JSON.stringify(file.name)} (${file.pageCount} pages; representative excerpts only)\n` +
        indexes.map((i) => `PAGE ${own[i]!.page}\n${own[i]!.text.slice(0, perPage)}`).join("\n\n")
      );
    })
    .join("\n\n---\n\n");
  return {
    context,
    files: files.length,
    sampledPages,
    totalPages: files.reduce((n, f) => n + f.pageCount, 0),
  };
}

export function validateColumnSuggestions(
  raw: unknown,
  existingNames: string[],
): ColumnSuggestion[] {
  const values =
    raw && typeof raw === "object" && "columns" in raw
      ? (raw as { columns: unknown }).columns
      : null;
  if (!Array.isArray(values) || values.length > 12)
    throw new Error("Invalid column suggestions. Try a more specific review objective.");
  const seen = new Set(existingNames.map((s) => s.trim().toLowerCase()));
  const out: ColumnSuggestion[] = [];
  for (const item of values) {
    if (!item || typeof item !== "object") continue;
    const c = item as ColumnSuggestion;
    if (
      typeof c.name !== "string" ||
      !c.name.trim() ||
      c.name.length > 100 ||
      typeof c.question !== "string" ||
      c.question.length < 12 ||
      c.question.length > 2000 ||
      !COLUMN_KINDS.some((k) => k.value === c.kind)
    )
      continue;
    if (
      !Array.isArray(c.options) ||
      c.options.some((o) => typeof o !== "string" || o.length > 120) ||
      c.options.length > 40
    )
      continue;
    if ((c.kind === "select" || c.kind === "multi_select") && c.options.length < 2) continue;
    const key = c.name.trim().toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      name: c.name.trim(),
      kind: c.kind,
      question: c.question.trim(),
      options: [...new Set(c.options)],
      reason:
        typeof c.reason === "string"
          ? c.reason.slice(0, 500)
          : "Review this question against your case objectives.",
    });
  }
  if (!out.length)
    throw new Error("No usable new columns were returned. Refine the objective and try again.");
  return out;
}
