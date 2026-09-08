// ============================================================================
// Tabular Review — value canonicalization.
//
// Two problems, one module:
//   1. Constrained columns (select / multi_select) must store an allowed
//      option or nothing. A model answer that is "almost" an option is mapped
//      to it when the match is unambiguous, and flagged otherwise.
//   2. Free-text columns drift: "Pfizer Inc." / "Pfizer, Inc" / "pfizer inc"
//      are one value. Within a column, spellings that differ only in case,
//      punctuation, whitespace or diacritics collapse to the most common
//      spelling. Nothing semantic is merged: "Pfizer" and "Pfizer Inc" stay
//      distinct, because that difference can matter in a record.
//
// Pure: no network, no React, no `@/` imports.
// ============================================================================

/** Lowercase, strip diacritics, drop punctuation, collapse whitespace. */
export function canonicalKey(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[\u2018\u2019\u201a\u201b\u201c\u201d\u201e\u201f]/g, "")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export type OptionMatch =
  | { option: string; method: "exact" | "normalized" | "fuzzy" }
  | { option: null; method: "none" | "ambiguous" };

function tokens(key: string): string[] {
  return key.split(" ").filter(Boolean);
}

/**
 * Map a model answer onto one of the column's options. Exact first, then
 * punctuation/case-insensitive, then a conservative fuzzy pass: the answer
 * contains the option (or vice versa) with at most two extra tokens, or the
 * token sets overlap by at least 80%. If two options both qualify the match is
 * ambiguous and nothing is chosen — a wrong option is worse than a flag.
 */
export function matchOption(value: string, options: readonly string[]): OptionMatch {
  const raw = value.trim();
  if (!raw || !options.length) return { option: null, method: "none" };
  const exact = options.find((o) => o === raw);
  if (exact !== undefined) return { option: exact, method: "exact" };

  const key = canonicalKey(raw);
  if (!key) return { option: null, method: "none" };
  const keyed = options.map((option) => ({ option, key: canonicalKey(option) }));
  const normalized = keyed.filter((o) => o.key === key);
  if (normalized.length === 1) return { option: normalized[0]!.option, method: "normalized" };
  if (normalized.length > 1) return { option: null, method: "ambiguous" };

  const valueTokens = tokens(key);
  const candidates = keyed.filter((o) => {
    if (!o.key) return false;
    const optionTokens = tokens(o.key);
    const contained =
      (key.includes(o.key) && valueTokens.length - optionTokens.length <= 2) ||
      (o.key.includes(key) && optionTokens.length - valueTokens.length <= 2);
    if (contained) return true;
    const a = new Set(valueTokens);
    const b = new Set(optionTokens);
    let shared = 0;
    for (const t of a) if (b.has(t)) shared++;
    const union = a.size + b.size - shared;
    return union > 0 && shared / union >= 0.8;
  });
  if (candidates.length === 1) return { option: candidates[0]!.option, method: "fuzzy" };
  return { option: null, method: candidates.length ? "ambiguous" : "none" };
}

export type Harmonization = {
  /** raw spelling → canonical spelling, only for values that change. */
  changes: Map<string, string>;
  /** Distinct values before and after. */
  before: number;
  after: number;
};

/**
 * Collapse spellings within one column that share a canonical key. The
 * canonical spelling is the most frequent raw form; ties go to the form with
 * the most capital letters and punctuation preserved (the "fullest" spelling),
 * then to first appearance.
 */
export function harmonizeValues(values: readonly string[]): Harmonization {
  const groups = new Map<string, Map<string, { count: number; first: number }>>();
  values.forEach((value, index) => {
    const raw = value.trim();
    if (!raw) return;
    const key = canonicalKey(raw);
    if (!key) return;
    const group = groups.get(key) ?? new Map();
    const entry = group.get(raw) ?? { count: 0, first: index };
    entry.count++;
    group.set(raw, entry);
    groups.set(key, group);
  });
  const changes = new Map<string, string>();
  let after = 0;
  for (const group of groups.values()) {
    after++;
    if (group.size < 2) continue;
    const ranked = [...group.entries()].sort(
      (a, b) =>
        b[1].count - a[1].count || richness(b[0]) - richness(a[0]) || a[1].first - b[1].first,
    );
    const canonical = ranked[0]![0];
    for (const [raw] of ranked.slice(1)) changes.set(raw, canonical);
  }
  const before = new Set(values.map((v) => v.trim()).filter(Boolean)).size;
  return { changes, before, after };
}

function richness(value: string): number {
  let score = 0;
  for (const ch of value) {
    if (ch !== ch.toLowerCase()) score += 2;
    else if (/[^\p{L}\p{N}\s]/u.test(ch)) score += 1;
  }
  return score;
}
