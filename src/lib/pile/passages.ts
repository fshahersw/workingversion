import type { Bm25Doc } from "./bm25";

/** Overlapping windows so a holding split across a page is still searchable. */
export function chunkText(text: string, maxChars = 900, overlap = 120): string[] {
  const clean = text.replace(/\s+/g, " ").trim();
  if (!clean) return [];
  if (clean.length <= maxChars) return [clean];
  const chunks: string[] = [];
  let i = 0;
  while (i < clean.length) {
    let end = Math.min(i + maxChars, clean.length);
    if (end < clean.length) {
      const sp = clean.lastIndexOf(" ", end);
      if (sp > i + Math.floor(maxChars * 0.5)) end = sp;
    }
    const piece = clean.slice(i, end).trim();
    if (piece) chunks.push(piece);
    if (end >= clean.length) break;
    i = Math.max(i + 1, end - overlap);
  }
  return chunks;
}

export function pagesToPassageDocs(
  pages: { fileId: string; fileName: string; page: number; text: string }[],
): Bm25Doc[] {
  const docs: Bm25Doc[] = [];
  for (const p of pages) {
    const chunks = chunkText(p.text);
    if (!chunks.length) {
      docs.push({ id: `${p.fileId}:${p.page}:0`, text: `${p.fileName} p.${p.page}` });
      continue;
    }
    chunks.forEach((chunk, i) => {
      docs.push({
        id: `${p.fileId}:${p.page}:${i}`,
        text: `${p.fileName} p.${p.page} ${chunk}`,
      });
    });
  }
  return docs;
}

/** Passage ids are fileId:page:chunk. Keep the best score per page. */
export function collapsePassageHits(hits: { id: string; score: number }[]): { pageId: string; score: number }[] {
  const best = new Map<string, number>();
  for (const hit of hits) {
    const cut = hit.id.lastIndexOf(":");
    const pageId = cut > 0 ? hit.id.slice(0, cut) : hit.id;
    const prev = best.get(pageId) ?? 0;
    if (hit.score > prev) best.set(pageId, hit.score);
  }
  return [...best.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([pageId, score]) => ({ pageId, score }));
}
