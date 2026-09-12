/** Bounded context without silently dropping pages, quotations, or late findings. */
export const DEPOSITION_CONTEXT_CHARS = 180_000;
export type EvidencePage = { fileName: string; page: number; text: string; cite?: string };

export function depositionContext(pages: EvidencePage[]): string {
  const context = pages
    .map((p) => `--- ${p.fileName} ${p.cite || `p. ${p.page}`} ---\n${p.text ?? ""}`)
    .join("\n\n");
  if (context.length > DEPOSITION_CONTEXT_CHARS) {
    throw new Error(
      "This analysis batch exceeds the evidence budget. Split it into smaller batches; no evidence was sent or truncated.",
    );
  }
  return context;
}

/** Split at paragraph boundaries where possible; overlap preserves testimony at a boundary. */
export function splitEvidencePage<T extends EvidencePage>(page: T, size = 24_000): T[] {
  if (page.text.length <= size) return [page];
  const out: T[] = [];
  let offset = 0;
  while (offset < page.text.length) {
    let end = Math.min(offset + size, page.text.length);
    const newline = page.text.lastIndexOf("\n", end);
    if (end < page.text.length && newline > offset + size / 2) end = newline;
    out.push({ ...page, text: page.text.slice(offset, end) });
    if (end === page.text.length) break;
    offset = end - 500;
  }
  return out;
}

export function batchEvidence<T extends EvidencePage>(
  pages: T[],
  budget = 80_000,
  maxPages = 32,
): T[][] {
  const out: T[][] = [];
  let batch: T[] = [],
    size = 0;
  for (const page of pages.flatMap((p) => splitEvidencePage(p))) {
    const chars = page.text.length + page.fileName.length + 80;
    if (batch.length && (size + chars > budget || batch.length >= maxPages)) {
      out.push(batch);
      batch = [];
      size = 0;
    }
    batch.push(page);
    size += chars;
  }
  if (batch.length) out.push(batch);
  return out;
}
