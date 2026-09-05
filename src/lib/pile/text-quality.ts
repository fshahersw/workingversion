/** Score 0–1 for how readable extracted PDF text is. PACER layers are often garbage. */
export function textQualityScore(text: string): number {
  const t = text.replace(/\s+/g, " ").trim();
  if (!t) return 0;
  const words = t.split(" ").filter(Boolean);
  const letters = (t.match(/[A-Za-z]/g) ?? []).length;
  const letterRatio = letters / t.length;
  const dirty = words.filter(isDirtyToken).length;
  const dirtyFrac = dirty / Math.max(words.length, 1);
  const shortFrac = words.filter((w) => w.length <= 2).length / Math.max(words.length, 1);
  let score = letterRatio;
  score -= dirtyFrac * 1.8;
  if (words.length >= 8) score -= Math.max(0, shortFrac - 0.28) * 0.9;
  return Math.max(0, Math.min(1, score));
}

function isDirtyToken(w: string): boolean {
  if (/[A-Za-z][^A-Za-z0-9'][A-Za-z]/.test(w)) return true;
  if (/[A-Za-z][0-9]|[0-9][A-Za-z]/.test(w)) return true;
  if (/[~^`<>|]/.test(w)) return true;
  if ((w.match(/[^A-Za-z0-9]/g) ?? []).length >= 2) return true;
  return false;
}

export function isLowQualityText(text: string): boolean {
  return textQualityScore(text) < 0.55;
}

/**
 * Pages that should go through Nemotron VL: empty, nearly empty, or a
 * garbage PACER/scan text layer that would poison retrieval.
 */
export function pageNeedsOcr(text: string, emptyChars = 120): boolean {
  const t = (text ?? "").replace(/\s+/g, " ").trim();
  if (t.length < emptyChars) return true;
  return isLowQualityText(text);
}
