// Wire schema for the litigation intelligence feed produced by the external
// Tavily/Firecrawl pipeline (`out/latest-feed.json`).
//
// The pipeline emits camelCase; this schema accepts it verbatim and normalizes
// to the snake_case row shape the corpus RPC expects. Unknown fields are
// dropped so pipeline additions never break ingestion.
import { z } from "zod";

export const INTEL_CONTRACT_VERSION = "intel-v1";

const isoDate = z
  .union([z.string(), z.number(), z.null()])
  .optional()
  .transform((v) => {
    if (v === null || v === undefined || v === "") return null;
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  });

const imageSchema = z
  .object({
    url: z.string().optional().nullable(),
    kind: z.string().optional().nullable(),
    alt: z.string().optional().nullable(),
  })
  .passthrough()
  .nullish();

const primarySourceSchema = z
  .object({
    id: z.string().optional(),
    title: z.string().optional(),
    url: z.string(),
    domain: z.string().optional().nullable(),
    summary: z.string().optional().nullable(),
    publishedAt: z.union([z.string(), z.null()]).optional(),
    rights: z.string().optional().nullable(),
  })
  .passthrough();

export const intelItemSchema = z.object({
  id: z.string().min(1),
  category: z.string().default("News"),
  title: z.string().min(1),
  url: z.string().url(),
  canonicalUrl: z.string().min(1).optional(),
  domain: z.string().optional().nullable(),
  sourceName: z.string().optional().nullable(),
  publishedAt: isoDate,
  fetchedAt: isoDate,
  summary: z.string().optional().nullable(),
  favicon: z.string().optional().nullable(),
  image: imageSchema,
  paywall: z.string().optional().nullable(),
  rights: z.string().optional().nullable(),
  renderMode: z.string().optional().nullable(),
  signalScore: z.number().optional().nullable(),
  tavilyScore: z.number().optional().nullable(),
  relatedTopics: z.array(z.string()).optional(),
  relatedSources: z.array(z.unknown()).optional(),
  queryPackIds: z.array(z.string()).optional(),
  primarySources: z.array(primarySourceSchema).optional(),
  analysisLead: z.string().optional().nullable(),
  analysisBullets: z.array(z.string()).optional(),
  analysisImpact: z.string().optional().nullable(),
  metadata: z
    .object({ author: z.string().nullish(), description: z.string().nullish() })
    .passthrough()
    .optional(),
});


export const intelFeedSchema = z.object({
  generatedAt: isoDate,
  schemaVersion: z.string().optional(),
  stats: z.record(z.unknown()).optional(),
  errors: z.record(z.unknown()).optional(),
  retainDays: z.number().int().min(1).max(730).optional(),
  items: z.array(intelItemSchema).min(1).max(500),
});

export type IntelFeed = z.infer<typeof intelFeedSchema>;
export type IntelItemInput = z.infer<typeof intelItemSchema>;

/** Row shape consumed by the `public.intel_ingest` RPC. */
export type IntelRow = {
  intel_id: string;
  canonical_url: string;
  url: string;
  category: string;
  title: string;
  summary: string | null;
  source_domain: string | null;
  source_name: string | null;
  favicon_url: string | null;
  image_url: string | null;
  image_kind: string | null;
  image_alt: string | null;
  signal_score: number;
  tavily_score: number | null;
  paywall: string | null;
  rights: string | null;
  render_mode: string | null;
  published_at: string | null;
  fetched_at: string;
  primary_sources: unknown[];
  related_topics: string[];
  related_sources: unknown[];
  pack_ids: string[];
  author: string | null;
  matter_slug: string | null;
  matter_label: string | null;
  analysis_lead: string | null;
  analysis_bullets: string[];
  analysis_impact: string | null;
};


function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return null;
  }
}

/** Strip tracking params + fragment so re-posts of the same story collapse. */
export function canonicalize(raw: string): string {
  try {
    const u = new URL(raw);
    u.hash = "";
    for (const p of [...u.searchParams.keys()]) {
      if (/^(utm_|fbclid|gclid|mc_|ref$|ref_|s_cid|cmp$)/i.test(p)) u.searchParams.delete(p);
    }
    let s = u.toString();
    if (s.endsWith("/") && u.pathname !== "/") s = s.slice(0, -1);
    return s;
  } catch {
    return raw;
  }
}

export function toRow(item: IntelItemInput, receivedAt: string): IntelRow {
  const canonical = canonicalize(item.canonicalUrl || item.url);
  const image = item.image ?? null;
  return {
    intel_id: item.id,
    canonical_url: canonical,
    url: item.url,
    category: item.category || "News",
    title: item.title.trim(),
    summary: item.summary?.trim() || item.metadata?.description || null,
    source_domain: item.domain || hostOf(item.url),
    source_name: item.sourceName || item.domain || hostOf(item.url),
    favicon_url: item.favicon || null,
    image_url: image?.url || null,
    image_kind: image?.kind || null,
    image_alt: image?.alt || null,
    signal_score: typeof item.signalScore === "number" ? item.signalScore : 0,
    tavily_score: typeof item.tavilyScore === "number" ? item.tavilyScore : null,
    paywall: item.paywall || null,
    rights: item.rights || null,
    render_mode: item.renderMode || null,
    published_at: item.publishedAt ?? null,
    fetched_at: item.fetchedAt ?? receivedAt,
    primary_sources: item.primarySources ?? [],
    related_topics: (item.relatedTopics ?? []).slice(0, 24),
    related_sources: item.relatedSources ?? [],
    pack_ids: item.queryPackIds ?? [],
    author: item.metadata?.author ?? null,
    matter_slug: null,
    matter_label: null,
    analysis_lead: item.analysisLead?.trim() || null,
    analysis_bullets: (item.analysisBullets ?? []).slice(0, 4),
    analysis_impact: item.analysisImpact?.trim() || null,
  };
}

