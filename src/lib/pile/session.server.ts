import { randomUUID } from "node:crypto";

import { mapPool, withRetry } from "./async";
import { buildIndex, search as bm25Search, type Bm25Index } from "./bm25";
import { pileStore, remainingTtl } from "./db.server";
import { EMBED_CONCURRENCY, MAX_FILES, MAX_PAGES } from "./limits";
import { collapsePassageHits, pagesToPassageDocs } from "./passages";
import { diversifyHits, expandNeighbors, expandQuery, looksCrossFile, roundRobinCover } from "./retrieve";
import { cosine, embedText } from "./titan.server";
import { isLowQualityText } from "./text-quality";
import { PILE_TTL_MS, type PileHit, type PilePage, type PileSession, type PileStructure } from "./types";
import { ocrPageImage } from "./vl-ocr.server";

const metaKey = (id: string) => `sess:${id}`;
const pagesKey = (id: string) => `sess:${id}:pages`;
const indexKey = (id: string) => `sess:${id}:index`;

function ttl(session: PileSession): number {
  return remainingTtl(session.expiresAt);
}

function requireSession(id: string): PileSession {
  const session = pileStore().get<PileSession>(metaKey(id));
  if (!session) throw new Error("Session expired or not found");
  return session;
}

function pagesOf(id: string): PilePage[] {
  return pileStore().get<PilePage[]>(pagesKey(id)) ?? [];
}

function savePages(session: PileSession, pages: PilePage[]) {
  const t = ttl(session);
  pileStore().set(pagesKey(session.id), pages, t);
  const index = buildIndex(pagesToPassageDocs(pages));
  pileStore().set(indexKey(session.id), index, t);
  pileStore().set(metaKey(session.id), session, t);
}

function toHit(page: PilePage, query: string, score: number): PileHit {
  return {
    fileId: page.fileId,
    fileName: page.fileName,
    page: page.page,
    score,
    snippet: snippet(page.text, query),
    garbled: isLowQualityText(page.text),
    ocr: page.ocr,
  };
}

function snippet(text: string, query: string): string {
  const raw = text.replace(/\s+/g, " ").trim();
  if (!raw) return "";
  const hay = raw.toLowerCase();
  const terms = query
    .toLowerCase()
    .split(/\s+/)
    .filter((w) => w.length > 2);
  let idx = -1;
  for (const t of terms) {
    idx = hay.indexOf(t);
    if (idx >= 0) break;
  }
  const start = Math.max(0, (idx < 0 ? 0 : idx) - 80);
  return raw.slice(start, start + 220);
}

export function createPileSession(input: { matterLabel?: string; instructions?: string } = {}): PileSession {
  const now = Date.now();
  const session: PileSession = {
    id: randomUUID(),
    createdAt: now,
    expiresAt: now + PILE_TTL_MS,
    matterLabel: input.matterLabel?.trim() || null,
    instructions: input.instructions?.trim() || null,
    files: [],
    pageCount: 0,
    structure: null,
  };
  pileStore().set(metaKey(session.id), session, PILE_TTL_MS);
  pileStore().set(pagesKey(session.id), [], PILE_TTL_MS);
  return session;
}

export function getPileSession(id: string): PileSession | null {
  return pileStore().get<PileSession>(metaKey(id));
}

export function ingestPile(
  id: string,
  files: { name: string; pages: { page: number; text: string }[] }[],
): PileSession {
  const session = requireSession(id);
  const pages: PilePage[] = [];
  let remaining = MAX_PAGES;
  const metaFiles = files.slice(0, MAX_FILES).map((f) => {
    const fileId = randomUUID();
    const take = f.pages.slice(0, Math.max(0, remaining));
    remaining -= take.length;
    const emptyPages = take.filter((p) => isLowQualityText(p.text ?? "")).length;
    for (const p of take) {
      pages.push({
        fileId,
        fileName: f.name,
        page: p.page,
        text: (p.text ?? "").trim(),
        ocr: false,
      });
    }
    return {
      id: fileId,
      name: f.name,
      pageCount: take.length,
      emptyPages,
      ocrPages: 0,
    };
  });
  session.files = metaFiles;
  session.pageCount = pages.length;
  session.structure = null;
  savePages(session, pages);
  return session;
}

export function searchPile(id: string, query: string, k = 12): PileHit[] {
  const session = requireSession(id);
  const pages = pagesOf(id);
  const index = pileStore().get<Bm25Index>(indexKey(id));
  const q = expandQuery(query, session.structure);
  if (!index || !q) return [];
  const keyword = bm25Search(index, q, Math.max(k * 8, 40));
  const byId = new Map(pages.map((p) => [`${p.fileId}:${p.page}`, p]));
  const ranked = collapsePassageHits(keyword)
    .map((hit) => {
      const page = byId.get(hit.pageId);
      if (!page) return null;
      return toHit(page, q, hit.score);
    })
    .filter((h): h is PileHit => !!h);
  return ranked.slice(0, k);
}

function applyRetrievePolicy(query: string, hits: PileHit[], k: number): PileHit[] {
  return looksCrossFile(query) ? diversifyHits(hits, k, 4) : diversifyHits(hits, k, 10);
}

/** Round-robin pages across files when Ask has no keyword hits. */
export function coveringHits(id: string, k = 12): PileHit[] {
  requireSession(id);
  const pages = pagesOf(id).filter((p) => p.text.trim());
  if (!pages.length) return [];
  return roundRobinCover(pages, k).map((page, i) => toHit(page, "", 1 / (i + 1)));
}

/** Optional hybrid rerank once Titan vectors exist on pages. */
export async function hybridSearchPile(id: string, query: string, k = 12): Promise<PileHit[]> {
  const keywordHits = searchPile(id, query, k * 2);
  const pages = pagesOf(id);
  const withVec = pages.filter((p) => p.embedding?.length);
  if (!withVec.length) return applyRetrievePolicy(query, keywordHits, k);
  let qv: number[] | null = null;
  try {
    qv = await embedText(expandQuery(query, getPileSession(id)?.structure));
  } catch {
    return applyRetrievePolicy(query, keywordHits, k);
  }
  if (!qv) return applyRetrievePolicy(query, keywordHits, k);
  const vecRank = withVec
    .map((p) => ({ p, score: cosine(qv, p.embedding!) }))
    .sort((a, b) => b.score - a.score);
  const rrf = new Map<string, number>();
  const add = (key: string, rank: number) => rrf.set(key, (rrf.get(key) ?? 0) + 1 / (60 + rank));
  keywordHits.forEach((h, i) => add(`${h.fileId}:${h.page}`, i));
  vecRank.forEach((h, i) => add(`${h.p.fileId}:${h.p.page}`, i));
  const byId = new Map(pages.map((p) => [`${p.fileId}:${p.page}`, p]));
  const ranked = [...rrf.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([key, score]) => {
      const page = byId.get(key)!;
      return toHit(page, query, score);
    });
  return applyRetrievePolicy(query, ranked, k);
}

export function packHitsForAsk(id: string, query: string, core: PileHit[], cap = 18): PileHit[] {
  const catalog = pagesOf(id).map((p) => toHit(p, query, 0));
  return expandNeighbors(core, catalog, 1).slice(0, cap);
}

export async function ocrPilePage(
  id: string,
  fileName: string,
  page: number,
  imageBase64: string,
): Promise<{ session: PileSession; text: string }> {
  const session = requireSession(id);
  const pages = pagesOf(id);
  const idx = pages.findIndex((p) => p.fileName === fileName && p.page === page);
  if (idx < 0) throw new Error("Unknown page");
  const text = await withRetry(() => ocrPageImage(imageBase64), {
    tries: 3,
    baseMs: 500,
    retry429: false,
  });
  if (text) {
    pages[idx] = { ...pages[idx]!, text, ocr: true };
    const file = session.files.find((f) => f.name === fileName);
    if (file) {
      file.ocrPages += 1;
      file.emptyPages = Math.max(0, file.emptyPages - 1);
    }
    savePages(session, pages);
  }
  return { session, text };
}

export async function embedPile(id: string, signal?: AbortSignal): Promise<number> {
  const session = requireSession(id);
  const pages = pagesOf(id);
  let n = 0;
  await mapPool(
    pages,
    EMBED_CONCURRENCY,
    async (p) => {
      if (signal?.aborted) return;
      if (p.embedding || !p.text.trim()) return;
      const vec = await withRetry(() => embedText(p.text, signal), { tries: 3, baseMs: 500, signal });
      if (vec) {
        p.embedding = vec;
        n += 1;
      }
    },
    signal,
  );
  savePages(session, pages);
  return n;
}

export async function structurePile(id: string): Promise<PileStructure> {
  const { structureFromPages } = await import("./structure.server");
  const session = requireSession(id);
  const structure = await structureFromPages({
    files: session.files,
    pages: pagesOf(id),
    matterLabel: session.matterLabel,
  });
  session.structure = structure;
  pileStore().set(metaKey(session.id), session, ttl(session));
  return structure;
}

export function pagesForHits(id: string, hits: PileHit[]): PilePage[] {
  const byId = new Map(pagesOf(id).map((p) => [`${p.fileId}:${p.page}`, p]));
  return hits.map((h) => byId.get(`${h.fileId}:${h.page}`)).filter((p): p is PilePage => !!p);
}
