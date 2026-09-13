// KB retrieval (server-only): embed the query (Titan) -> hybrid_search (pgvector
// + BM25 RRF) -> Bedrock rerank (cohere.rerank-v3-5:0) -> top-K passages. Bedrock
// calls are lazy-imported so the module (and its unit test for the pure
// result-parser) load under node without resolving the @/ alias.

import { hybridSearch, type KbHit, type KbSurface } from "./aurora.server";
import { parseRerankOrder } from "./rerank-parse";

const RERANK_MODEL = process.env["BEDROCK_RERANK_MODEL"] ?? "cohere.rerank-v3-5:0";
const RERANK_MAX_DOCS = 1000; // Bedrock Rerank hard cap
const RERANK_DOC_CHARS = 3500; // keep each doc within the model's context

/** Rerank `docs` against `query`; returns the reranked index order (top ~topK).
 *  Throws on transport error so the caller can fall back to fused order. */
export async function rerankPassages(
  query: string,
  docs: string[],
  topK: number,
  signal?: AbortSignal,
): Promise<number[]> {
  const region = process.env["BEDROCK_REGION"] ?? process.env["AWS_REGION"] ?? "us-east-1";
  const modelArn = `arn:aws:bedrock:${region}::foundation-model/${RERANK_MODEL}`;
  const sources = docs.slice(0, RERANK_MAX_DOCS).map((d) => ({
    type: "INLINE",
    inlineDocumentSource: { type: "TEXT", textDocument: { text: (d || "").slice(0, RERANK_DOC_CHARS) } },
  }));
  const body = JSON.stringify({
    queries: [{ type: "TEXT", textQuery: { text: query.slice(0, 2000) } }],
    sources,
    rerankingConfiguration: {
      type: "BEDROCK_RERANKING_MODEL",
      bedrockRerankingConfiguration: {
        numberOfResults: Math.min(topK, sources.length),
        modelConfiguration: { modelArn },
      },
    },
  });
  const { signedAwsFetch } = await import("@/lib/agents/bedrock-sign.server");
  const res = await signedAwsFetch(
    // SigV4 scope for the bedrock-agent-runtime endpoint is service "bedrock";
    // signing it as "bedrock-agent-runtime" 403s (previously caught + silently
    // fell back to fused order, degrading rerank).
    "bedrock",
    `https://bedrock-agent-runtime.${region}.amazonaws.com/rerank`,
    { body, ...(signal ? { signal } : {}) },
  );
  if (!res.ok) throw new Error(`rerank failed [${res.status}]`);
  return parseRerankOrder(await res.json(), sources.length);
}

export type KbSearchArgs = {
  workspaceId: string;
  surface: KbSurface;
  query: string;
  /** Final passages returned after rerank. */
  topK?: number;
  /** Fused candidates fetched before rerank. */
  candidates?: number;
  docIds?: string[];
  signal?: AbortSignal;
};

/**
 * Hybrid search + rerank. Degrades gracefully: lexical-only if the embedder
 * fails, fused order if rerank fails. Returns bounded snippets (full bodies come
 * from fetchChunks at synthesis time).
 */
export async function searchKb(sub: string, args: KbSearchArgs): Promise<KbHit[]> {
  const topK = args.topK ?? 12;
  const { embedText } = await import("@/lib/pile/titan.server");
  const embedding = await embedText(args.query, args.signal).catch(() => null);

  const hits = await hybridSearch({
    sub,
    workspaceId: args.workspaceId,
    surface: args.surface,
    query: args.query,
    embedding,
    match: args.candidates ?? 120,
    ...(args.docIds ? { docIds: args.docIds } : {}),
  });
  if (hits.length <= topK) return hits;

  try {
    const order = await rerankPassages(
      args.query,
      hits.map((h) => h.content),
      topK,
      args.signal,
    );
    return order
      .map((i) => hits[i])
      .filter((h): h is KbHit => Boolean(h))
      .slice(0, topK);
  } catch {
    return hits.slice(0, topK);
  }
}

export type KbDocumentPages = {
  docId: string;
  /** Pages ranked by their best fused chunk score, strongest first. */
  pages: { page: number; score: number }[];
};

/**
 * Per-document page ranking for one question: the same pgvector + BM25 fusion,
 * run independently inside each document so no document is crowded out by a
 * more verbose neighbour. Used by Tabular Review, where a cell is answered
 * from one document only. The query is embedded once; documents are searched
 * in a small pool. Degrades to lexical-only if the embedder fails.
 */
export async function searchKbByDocuments(
  sub: string,
  args: {
    workspaceId: string;
    surface: KbSurface;
    query: string;
    docIds: string[];
    perDocPages?: number;
    signal?: AbortSignal;
  },
): Promise<KbDocumentPages[]> {
  const perDocPages = Math.max(1, Math.min(args.perDocPages ?? 12, 32));
  if (!args.docIds.length) return [];
  const { embedText } = await import("@/lib/pile/titan.server");
  const { mapPool } = await import("@/lib/pile/async");
  const embedding = await embedText(args.query, args.signal).catch(() => null);
  return mapPool(args.docIds, 6, async (docId) => {
    if (args.signal?.aborted) return { docId, pages: [] };
    let hits: KbHit[] = [];
    try {
      hits = await hybridSearch({
        sub,
        workspaceId: args.workspaceId,
        surface: args.surface,
        query: args.query,
        embedding,
        match: Math.max(24, perDocPages * 3),
        snippetChars: 120,
        docIds: [docId],
      });
    } catch {
      return { docId, pages: [] };
    }
    const byPage = new Map<number, number>();
    for (const hit of hits) {
      const start = hit.page_start ?? 0;
      const end = hit.page_end ?? start;
      for (let page = start; page <= Math.min(end, start + 2); page++) {
        if (page <= 0) continue;
        byPage.set(page, Math.max(byPage.get(page) ?? 0, hit.score));
      }
    }
    const pages = [...byPage.entries()]
      .sort((a, b) => b[1] - a[1] || a[0] - b[0])
      .slice(0, perDocPages)
      .map(([page, score]) => ({ page, score }));
    return { docId, pages };
  });
}
