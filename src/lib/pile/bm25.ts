export type Bm25Doc = { id: string; text: string };

type Posting = { d: number; tf: number };

/**
 * Inverted-index BM25. Built once during ingest and updated in place, so a query
 * only touches the postings of its own terms instead of re-tokenizing the corpus.
 */
export type Bm25Index = {
  /** Live (non-tombstoned) document count. */
  N: number;
  totalDl: number;
  df: Map<string, number>;
  postings: Map<string, Posting[]>;
  docs: { id: string; dl: number }[];
  byId: Map<string, number>;
  deleted: Set<number>;
};

const K1 = 1.2;
const B = 0.75;

export function tokenize(text: string): string[] {
  const lower = text.toLowerCase();
  const basic = lower.match(/[a-z0-9]+/g) ?? [];
  const docket = lower.match(/\d+:\d+-[a-z]+-\d+/g) ?? [];
  return [...basic, ...docket].filter((t) => t.length > 1 || /\d/.test(t));
}

export function createIndex(): Bm25Index {
  return {
    N: 0,
    totalDl: 0,
    df: new Map(),
    postings: new Map(),
    docs: [],
    byId: new Map(),
    deleted: new Set(),
  };
}

/** Add one document. Re-adding an existing id tombstones the old copy first. */
export function addDoc(index: Bm25Index, doc: Bm25Doc): void {
  const existing = index.byId.get(doc.id);
  if (existing !== undefined) removeDoc(index, doc.id);

  const tokens = tokenize(doc.text);
  const tf = new Map<string, number>();
  for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1);

  const d = index.docs.length;
  index.docs.push({ id: doc.id, dl: tokens.length });
  index.byId.set(doc.id, d);
  index.N += 1;
  index.totalDl += tokens.length;

  for (const [term, count] of tf) {
    const list = index.postings.get(term);
    if (list) list.push({ d, tf: count });
    else index.postings.set(term, [{ d, tf: count }]);
    index.df.set(term, (index.df.get(term) ?? 0) + 1);
  }
}

export function addDocs(index: Bm25Index, docs: Bm25Doc[]): void {
  for (const doc of docs) addDoc(index, doc);
}

/**
 * Tombstone a document. Postings are left in place (they are skipped at scoring
 * time); only the corpus statistics that matter for ranking are corrected.
 */
export function removeDoc(index: Bm25Index, id: string): void {
  const d = index.byId.get(id);
  if (d === undefined || index.deleted.has(d)) return;
  index.deleted.add(d);
  index.byId.delete(id);
  index.N = Math.max(0, index.N - 1);
  index.totalDl = Math.max(0, index.totalDl - (index.docs[d]?.dl ?? 0));
}

export function buildIndex(docs: Bm25Doc[]): Bm25Index {
  const index = createIndex();
  addDocs(index, docs);
  return index;
}

/**
 * Query terms so common in THIS index that they carry no signal. Pruned at
 * query time only — nothing is removed from the index, so captions and docket
 * strings stay exactly matchable.
 */
const COMMON_DF_RATIO = 0.6;

/** Legal-operative words that must never be pruned, however common they are. */
const PROTECTED_TERMS = new Set([
  "not",
  "no",
  "nor",
  "shall",
  "may",
  "must",
  "all",
  "any",
  "each",
  "without",
  "except",
  "unless",
  "before",
  "after",
]);

function selective(term: string): boolean {
  return PROTECTED_TERMS.has(term) || /\d/.test(term);
}

/**
 * Drop near-universal terms ("the", "and", boilerplate headers) from a query.
 * If pruning would leave nothing, the original terms are kept — an all-common
 * query still returns results rather than silently matching nothing.
 */
export function pruneQueryTerms(index: Bm25Index, terms: string[]): string[] {
  const unique: string[] = [];
  const seen = new Set<string>();
  for (const t of terms) {
    if (seen.has(t)) continue;
    seen.add(t);
    unique.push(t);
  }
  if (!index.N) return unique;
  const kept = unique.filter((t) => {
    if (selective(t)) return true;
    const df = index.df.get(t) ?? 0;
    return df / index.N <= COMMON_DF_RATIO;
  });
  // Only fall back when pruning removed every term that could actually match:
  // a surviving term with no postings is not evidence the prune was safe.
  const scorable = kept.some((t) => (index.df.get(t) ?? 0) > 0);
  return scorable ? kept : unique;
}

export function search(index: Bm25Index, query: string, k = 12): { id: string; score: number }[] {
  const tokens = tokenize(query);
  if (!tokens.length || !index.N) return [];
  const q = pruneQueryTerms(index, tokens);
  const avgdl = index.totalDl / Math.max(index.N, 1);
  const scores = new Map<number, number>();
  for (const term of q) {
    const n = index.df.get(term) ?? 0;
    const list = index.postings.get(term);
    if (!n || !list) continue;
    const idf = Math.log(1 + (index.N - n + 0.5) / (n + 0.5));
    for (const p of list) {
      if (index.deleted.has(p.d)) continue;
      const dl = index.docs[p.d]?.dl ?? 0;
      const denom = p.tf + K1 * (1 - B + B * (dl / Math.max(avgdl, 1)));
      scores.set(p.d, (scores.get(p.d) ?? 0) + idf * ((p.tf * (K1 + 1)) / denom));
    }
  }
  return [...scores.entries()]
    .map(([d, score]) => ({ id: index.docs[d]?.id ?? "", score }))
    .filter((h) => h.id)
    .sort((a, b) => b.score - a.score)
    .slice(0, k);
}
