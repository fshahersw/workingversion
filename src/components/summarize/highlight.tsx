const STOP = new Set([
  "the",
  "and",
  "for",
  "with",
  "that",
  "this",
  "from",
  "are",
  "was",
  "were",
  "what",
  "which",
  "here",
  "there",
  "into",
  "about",
]);

export function queryTerms(query: string): string[] {
  return Array.from(
    new Set(
      query
        .toLowerCase()
        .split(/[^a-z0-9$#.-]+/i)
        .map((w) => w.replace(/^[.-]+|[.-]+$/g, ""))
        .filter((w) => w.length > 2 && !STOP.has(w)),
    ),
  );
}

export function Highlight({ text, query }: { text: string; query: string }) {
  const terms = queryTerms(query);
  if (!terms.length) return <>{text}</>;
  const re = new RegExp(
    `(${terms.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})`,
    "gi",
  );
  const parts = text.split(re);
  const lookup = new Set(terms);
  return (
    <>
      {parts.map((part, i) =>
        lookup.has(part.toLowerCase()) ? (
          <mark
            key={i}
            className="rounded-[3px] bg-brand-orange/20 px-0.5 font-medium text-foreground"
          >
            {part}
          </mark>
        ) : (
          <span key={i}>{part}</span>
        ),
      )}
    </>
  );
}

/** How many query-term occurrences a page text contains. */
export function countMatches(text: string, query: string): number {
  const terms = queryTerms(query);
  if (!terms.length) return 0;
  const re = new RegExp(
    `(${terms.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})`,
    "gi",
  );
  return (text.match(re) ?? []).length;
}
