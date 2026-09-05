/** Prefer hits from several files so Ask is not dominated by one long PDF. */
export function diversifyHits<T extends { fileId: string }>(hits: T[], k: number, perFile = 4): T[] {
  const picked: T[] = [];
  const deferred: T[] = [];
  const count = new Map<string, number>();
  for (const hit of hits) {
    const n = count.get(hit.fileId) ?? 0;
    if (n < perFile) {
      picked.push(hit);
      count.set(hit.fileId, n + 1);
    } else {
      deferred.push(hit);
    }
    if (picked.length >= k) return picked;
  }
  for (const hit of deferred) {
    if (picked.length >= k) break;
    picked.push(hit);
  }
  return picked.slice(0, k);
}

/** Walk files in round-robin so covering retrieval is multi-file, not front-loaded. */
export function roundRobinCover<T extends { fileId: string }>(pages: T[], k: number): T[] {
  const queues = new Map<string, T[]>();
  for (const page of pages) {
    const q = queues.get(page.fileId) ?? [];
    q.push(page);
    queues.set(page.fileId, q);
  }
  const buckets = [...queues.values()];
  const out: T[] = [];
  let i = 0;
  while (out.length < k && buckets.some((q) => q.length)) {
    const q = buckets[i % buckets.length]!;
    const next = q.shift();
    if (next) out.push(next);
    i += 1;
  }
  return out;
}

/** First, second, last, and evenly spaced pages from every file — not just the first 200 in order. */
export function samplePagesForStructure<T extends { fileName: string; page: number }>(
  pages: T[],
  maxPerFile = 8,
): T[] {
  const byFile = new Map<string, T[]>();
  for (const page of pages) {
    const g = byFile.get(page.fileName) ?? [];
    g.push(page);
    byFile.set(page.fileName, g);
  }
  const out: T[] = [];
  for (const group of byFile.values()) {
    if (group.length <= maxPerFile) {
      out.push(...group);
      continue;
    }
    const idx = new Set<number>([0, Math.min(1, group.length - 1), group.length - 1]);
    const extra = Math.max(0, maxPerFile - idx.size);
    for (let n = 1; n <= extra; n++) {
      idx.add(Math.round((n / (extra + 1)) * (group.length - 1)));
    }
    out.push(
      ...[...idx]
        .sort((a, b) => a - b)
        .map((i) => group[i]!)
        .filter(Boolean),
    );
  }
  return out;
}

/** Pinpoint questions may use many pages from one file; compare questions should not. */
export function looksCrossFile(query: string): boolean {
  return /\b(compar(?:e|ing)|versus|\bvs\.?\b|across|between|contradict|each file|all (?:the )?docs?|both exhibits|multi-?file)\b/i.test(
    query,
  );
}

export function expandQuery(
  query: string,
  structure: { parties: string[]; issues: string[] } | null | undefined,
): string {
  const q = query.trim();
  if (!structure || !q) return q;
  const lower = q.toLowerCase();
  const extra: string[] = [];
  for (const party of structure.parties) {
    const last = party.trim().split(/\s+/).pop() ?? "";
    if (last.length > 3 && lower.includes(last.toLowerCase()) && !lower.includes(party.toLowerCase())) {
      extra.push(party);
    }
  }
  for (const issue of structure.issues) {
    const key = issue.trim();
    if (key.length > 4 && lower.includes(key.slice(0, 8).toLowerCase()) && !lower.includes(key.toLowerCase())) {
      extra.push(key);
    }
  }
  return extra.length ? `${q} ${extra.join(" ")}` : q;
}

export function parseRerankIds(raw: string, k: number): string[] {
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) return [];
  try {
    const parsed = JSON.parse(match[0]) as { ids?: unknown };
    if (!Array.isArray(parsed.ids)) return [];
    const out: string[] = [];
    const seen = new Set<string>();
    for (const id of parsed.ids) {
      if (typeof id !== "string" || !/^[^:]+:\d+$/.test(id) || seen.has(id)) continue;
      seen.add(id);
      out.push(id);
      if (out.length >= k) break;
    }
    return out;
  } catch {
    return [];
  }
}

/** If page 40 hits, also keep 39 and 41 from the same file. */
export function expandNeighbors<T extends { fileId: string; page: number }>(
  hits: T[],
  catalog: T[],
  radius = 1,
): T[] {
  const byFile = new Map<string, Map<number, T>>();
  for (const page of catalog) {
    const m = byFile.get(page.fileId) ?? new Map<number, T>();
    m.set(page.page, page);
    byFile.set(page.fileId, m);
  }
  const seen = new Set<string>();
  const out: T[] = [];
  const add = (page: T | undefined) => {
    if (!page) return;
    const key = `${page.fileId}:${page.page}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push(page);
  };
  for (const hit of hits) {
    add(hit);
    const pages = byFile.get(hit.fileId);
    if (!pages) continue;
    for (let d = 1; d <= radius; d++) {
      add(pages.get(hit.page - d));
      add(pages.get(hit.page + d));
    }
  }
  return out;
}
