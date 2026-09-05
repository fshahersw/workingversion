// Utilities for extracting the sentence(s) carrying a [S#] marker
// and finding the best-matching passage inside a source chunk.

const STOPWORDS = new Set([
  "the","a","an","and","or","of","to","in","on","for","with","by","is","are",
  "was","were","be","been","being","as","at","that","this","these","those",
  "it","its","from","which","who","whom","whose","but","not","no","if","then",
  "than","so","such","into","over","under","may","must","shall","will","can",
  "could","should","would","do","does","did","has","have","had","also","any",
  "all","other","such","per","upon","within","without","about",
]);

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/\[s\d+\]/g, " ")
    .replace(/[^\p{L}\p{N}\s-]/gu, " ")
    .split(/\s+/)
    .filter((t) => t && t.length > 1 && !STOPWORDS.has(t));
}

/** Extract the sentence(s) in `answer` that carry the given citation ref (e.g. "S3"). */
export function sentencesForRef(answer: string, ref: string): string {
  if (!answer) return "";
  // Split into sentences, keeping markers attached.
  const parts = answer
    .replace(/\n+/g, " ")
    .split(/(?<=[.!?])\s+(?=[A-Z\[(])/);
  const marker = `[${ref}]`;
  const out: string[] = [];
  for (let i = 0; i < parts.length; i++) {
    if (parts[i].includes(marker)) {
      out.push(parts[i]);
      // include next sentence if it continues with the same marker
      if (parts[i + 1] && parts[i + 1].includes(marker)) {
        out.push(parts[i + 1]);
        i++;
      }
    }
  }
  return out.join(" ").trim();
}

/**
 * Find the contiguous window in `content` with highest token-overlap to `query`.
 * Returns [start, end] indices in `content`, or null if overlap is weak.
 */
export function findBestSpan(
  content: string,
  query: string,
): { start: number; end: number; score: number } | null {
  if (!content || !query) return null;
  const qTokens = new Set(tokenize(query));
  if (qTokens.size < 2) return null;

  // Sentence-level scan first for clean boundaries.
  const sentenceRe = /[^.!?\n]+[.!?]?/g;
  const sentences: { text: string; start: number; end: number }[] = [];
  let m: RegExpExecArray | null;
  while ((m = sentenceRe.exec(content)) !== null) {
    sentences.push({
      text: m[0],
      start: m.index,
      end: m.index + m[0].length,
    });
  }
  if (sentences.length === 0) return null;

  // Score each contiguous 1..3 sentence window.
  let best: { start: number; end: number; score: number } | null = null;
  for (let i = 0; i < sentences.length; i++) {
    for (let w = 1; w <= Math.min(3, sentences.length - i); w++) {
      const slice = sentences.slice(i, i + w);
      const tokens = tokenize(slice.map((s) => s.text).join(" "));
      if (tokens.length === 0) continue;
      let hits = 0;
      for (const t of tokens) if (qTokens.has(t)) hits++;
      // Normalize by sqrt(length) to avoid favoring very long windows.
      const score = hits / Math.sqrt(tokens.length);
      if (!best || score > best.score) {
        best = {
          start: slice[0].start,
          end: slice[slice.length - 1].end,
          score,
        };
      }
    }
  }
  // Require a meaningful overlap.
  if (!best || best.score < 0.6) return null;
  return best;
}
