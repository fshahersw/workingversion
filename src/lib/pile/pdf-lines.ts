export type PdfGlyph = {
  x: number;
  y: number;
  w: number;
  h: number;
  str: string;
};

/** Rebuild reporter-style lines (left gutter line numbers + body) from PDF glyphs. */
export function reconstructReporterLines(glyphs: PdfGlyph[]): string {
  const rows = glyphs.filter((g) => g.str || g.w);
  if (!rows.length) return "";

  const sorted = [...rows].sort((a, b) => b.y - a.y || a.x - b.x);
  const lines: PdfGlyph[][] = [];
  let cur: PdfGlyph[] = [];
  let y = sorted[0]!.y;
  let h = sorted[0]!.h || 12;

  for (const it of sorted) {
    const dy = Math.abs(it.y - y);
    const thresh = Math.max(h, it.h || 12) * 0.48;
    if (cur.length && dy > thresh) {
      lines.push(cur);
      cur = [it];
      y = it.y;
      h = it.h || 12;
    } else {
      cur.push(it);
      if (cur.length === 1) {
        y = it.y;
        h = it.h || 12;
      }
    }
  }
  if (cur.length) lines.push(cur);

  const xs = rows.map((r) => r.x);
  const minX = Math.min(...xs);
  const maxX = Math.max(...rows.map((r) => r.x + (r.w || 0)));
  const width = Math.max(maxX - minX, 1);
  const gutter = minX + Math.min(width * 0.14, 56);

  return lines
    .map((items) => {
      const ordered = [...items].sort((a, b) => a.x - b.x);
      const first = ordered[0]!;
      const num = first.str.trim();
      const isLineNo =
        first.x <= gutter && /^\d{1,2}$/.test(num) && Number(num) >= 1 && Number(num) <= 50;
      const rest = isLineNo ? ordered.slice(1) : ordered;
      let text = "";
      let lastEnd = isLineNo ? first.x + (first.w || 0) : rest[0] ? rest[0].x : 0;
      for (const it of rest) {
        if (text && it.x - lastEnd > Math.max(it.h || 12, 8) * 0.18) text += " ";
        text += it.str;
        lastEnd = it.x + (it.w || 0);
      }
      text = text.replace(/[ \t]+/g, " ").trim();
      if (!text && !isLineNo) return "";
      return isLineNo ? `${num}  ${text}` : text;
    })
    .filter(Boolean)
    .join("\n");
}
