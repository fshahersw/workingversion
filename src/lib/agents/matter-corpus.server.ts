// ============================================================================
// Matter docket-corpus retrieval (server-only).
//
// The firm's collected docket filings are ingested, per matter, into Bedrock
// MANAGED Knowledge Bases (one KB per MDL, populated out-of-band from the S3
// docket corpus). `corpus.matters.kb_id` links a matter to its KB. This module
// resolves a matter reference to its KB and Retrieves passages by meaning.
//
// This is the PERSISTENT per-matter docket RAG. It is distinct from:
//   - the per-user Discovery pile (Aurora kb.*), searched via lib/kb, and
//   - the LIVE DocketBird db_* tools, which hit DocketBird's API for any case.
// We only READ these KBs here; creation + ingestion happen out-of-band.
// ============================================================================
import { signedAwsFetch } from "@/lib/agents/bedrock-sign.server";
import { queryJson } from "@/lib/kb/aurora.server";

const REGION = process.env["BEDROCK_REGION"] ?? process.env["AWS_REGION"] ?? "us-east-1";

export type MatterKb = { matterId: string; title: string; kbId: string };

// Matters change only when a sync/backfill lands; a short per-container memo
// keeps repeat tool calls from re-querying the linkage every time.
const TTL_MS = 5 * 60_000;
let _cache: { at: number; rows: MatterKb[] } | null = null;

/** Matters with a linked Bedrock KB (`corpus.matters.kb_id`). Cached; fail-open. */
export async function listMatterKbs(): Promise<MatterKb[]> {
  if (_cache && Date.now() - _cache.at < TTL_MS) return _cache.rows;
  const rows = await queryJson<{ matterId: string; title: string | null; kbId: string }>(
    `SELECT matter_id AS "matterId", title AS "title", kb_id AS "kbId"
       FROM corpus.matters
      WHERE kb_id IS NOT NULL AND kb_id <> ''
      ORDER BY title`,
  ).catch(() => [] as { matterId: string; title: string | null; kbId: string }[]);
  const out: MatterKb[] = rows.map((r) => ({
    matterId: r.matterId,
    title: r.title ?? r.matterId,
    kbId: r.kbId,
  }));
  _cache = { at: Date.now(), rows: out };
  return out;
}

const norm = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

/**
 * Resolve a free-text matter reference (name or MDL) to its KB. Direct substring
 * match on matter_id/title first, then best distinctive-token overlap. Returns
 * null when nothing matches confidently (the caller then lists the options).
 */
export async function resolveMatterKb(queryText: string): Promise<MatterKb | null> {
  const matters = await listMatterKbs();
  if (!matters.length) return null;
  const q = norm(queryText);
  if (!q) return null;

  const direct = matters.find(
    (m) =>
      norm(m.matterId).includes(q) || norm(m.title).includes(q) || q.includes(norm(m.matterId)),
  );
  if (direct) return direct;

  const qTokens = new Set(q.split(" ").filter((t) => t.length > 2));
  let best: { m: MatterKb; score: number } | null = null;
  for (const m of matters) {
    const hay = new Set(`${norm(m.matterId)} ${norm(m.title)}`.split(" ").filter(Boolean));
    let score = 0;
    for (const t of qTokens) if (hay.has(t)) score++;
    if (score > 0 && (!best || score > best.score)) best = { m, score };
  }
  return best?.m ?? null;
}

export type CorpusPassage = {
  text: string;
  score: number;
  /** S3 URI of the source object, when the KB reports one. */
  location?: string;
  /** Chunk metadata attributes (title, docket_number, date_filed, doc_type, …). */
  metadata?: Record<string, unknown>;
};

/**
 * Retrieve top-K passages from a matter's Bedrock managed KB (data-plane
 * `Retrieve`; the KB embeds the query with its own model). Throws on transport
 * error so the tool can surface it.
 */
export async function retrieveMatterCorpus(
  kbId: string,
  query: string,
  k: number,
  signal?: AbortSignal,
): Promise<CorpusPassage[]> {
  const body = JSON.stringify({
    retrievalQuery: { text: query.slice(0, 2000) },
    retrievalConfiguration: {
      vectorSearchConfiguration: { numberOfResults: Math.min(Math.max(k, 1), 25) },
    },
  });
  const res = await signedAwsFetch(
    "bedrock-agent-runtime",
    `https://bedrock-agent-runtime.${REGION}.amazonaws.com/knowledgebases/${encodeURIComponent(
      kbId,
    )}/retrieve`,
    { body, ...(signal ? { signal } : {}) },
  );
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`KB retrieve failed [${res.status}]: ${detail.slice(0, 200)}`);
  }
  const json = (await res.json()) as {
    retrievalResults?: {
      content?: { text?: string };
      location?: { s3Location?: { uri?: string } };
      score?: number;
      metadata?: Record<string, unknown>;
    }[];
  };
  return (json.retrievalResults ?? [])
    .map((r) => ({
      text: (r.content?.text ?? "").trim(),
      score: typeof r.score === "number" ? r.score : 0,
      ...(r.location?.s3Location?.uri ? { location: r.location.s3Location.uri } : {}),
      ...(r.metadata ? { metadata: r.metadata } : {}),
    }))
    .filter((p) => p.text);
}
