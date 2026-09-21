// ============================================================================
// Legal Archive access policy (pure): which upstream paths the platform may
// call, how upstream URLs are built, and the caveats every answer must carry.
//
// The archive (externalcorpus directory server) and the Corpus Workbench are
// read-only JSON services with no authentication of their own. The platform
// reaches them server-side only, through its own distribution
// (/archive-api/*, /workbench-api/*) with the gateway's app key. This module
// is the allow-list in front of that: a browser-facing route never forwards a
// path that is not named here, and the model never sees an archive answer
// without the qualification text the archive's own ground rules require.
// ============================================================================

/** JSON as the archive returns it; server functions need a serializable shape, not `unknown`. */
export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

/** Upstream archive API paths the platform forwards (exact or prefix match on a segment boundary). */
export const ARCHIVE_ALLOWED_PATHS: readonly string[] = [
  "/api/summary",
  "/api/supplements",
  "/api/coverage/labels",
  "/api/coverage/matrix",
  "/api/coverage/state",
  "/api/coverage/topics",
  "/api/coverage/venues",
  "/api/documents",
  "/api/record",
  "/api/text",
  "/api/law-outline",
  "/api/law-outline/children",
  "/api/law-outline/provisions",
  "/api/law-outline/context",
  "/api/regulation",
  "/api/regulations/search",
  "/api/regulations/document",
  "/api/regulations/info",
  "/api/regulations/parts",
  "/api/regulations/sections",
  "/api/regulations/titles",
  "/api/regulations/agencies",
  "/api/area",
  "/api/blocks",
  "/api/citations/record",
  "/api/court-resolve",
  "/api/judges",
  "/api/judge",
  "/api/people",
  "/api/person",
  "/api/mdls",
  "/api/mdls/summary",
  "/api/mdls/for-judge",
  "/api/mdls/for-person",
  "/api/mdl",
  "/api/counties",
  "/api/county-filing",
  "/api/county-filing/coverage",
  "/api/county-filing/state",
  "/api/county-filing/state-counties",
  "/api/county-registry",
  "/api/county-litigation",
  "/api/county-litigation-record",
  "/api/agency-hub",
  "/api/agency-hub/item",
  "/api/agency/search",
  "/api/agency/record",
  "/api/agency/datasets",
  "/api/agency/status",
  "/api/agency/cfr",
  "/api/agency/firm",
  "/api/explore",
  "/api/collections",
  "/api/collection",
  "/api/resources",
  "/api/resource",
  "/api/sources",
  "/api/source",
  "/api/urls/block",
  "/supplement-files",
];

/** Workbench API paths the platform forwards. */
export const WORKBENCH_ALLOWED_PATHS: readonly string[] = [
  "/api/health",
  "/api/config",
  "/api/search",
  "/api/record",
  "/api/citations",
  "/api/cited-by",
  "/api/resolve",
  "/api/related",
  "/api/compare",
];

/** Entries that only make sense with a child segment (an area name, a file id). */
const PREFIX_ONLY = new Set(["/api/area", "/supplement-files"]);

function matches(path: string, allowed: readonly string[]): boolean {
  if (!path.startsWith("/") || path.includes("..") || path.includes("//") || /[\s\\]/.test(path)) return false;
  return allowed.some((a) => (PREFIX_ONLY.has(a) ? path.startsWith(`${a}/`) && path.length > a.length + 1 : path === a || path.startsWith(`${a}/`)));
}

export const isAllowedArchivePath = (path: string): boolean => matches(path, ARCHIVE_ALLOWED_PATHS);
export const isAllowedWorkbenchPath = (path: string): boolean => matches(path, WORKBENCH_ALLOWED_PATHS);

/** Query parameters are passed through verbatim except these, which the platform owns. */
const DROPPED_QUERY_KEYS = new Set(["app_key", "origin_key"]);

export function buildUpstreamUrl(base: string, prefix: "/archive-api" | "/workbench-api", path: string, query: URLSearchParams | Record<string, string> | undefined): string {
  const url = new URL(`${prefix}${path}`, base.endsWith("/") ? base : `${base}/`);
  const entries = query instanceof URLSearchParams ? [...query.entries()] : Object.entries(query ?? {});
  for (const [k, v] of entries) if (!DROPPED_QUERY_KEYS.has(k) && v !== undefined && v !== null) url.searchParams.append(k, String(v));
  return url.toString();
}

/** The archive's ground rules, in the words every answer built on it must carry. */
export const ARCHIVE_CAVEATS = {
  snapshot: "Saved snapshot (a bulk snapshot or an official capture) as of the stated date; confirm the current edition and status at the official source.",
  incomplete: "The collection is not complete: a missing record means not saved here, not that it does not exist. Known holes: Georgia and North Carolina statutes; Pennsylvania unconsolidated statutes; MA, NH, MI and NC county sources are mostly blocked.",
  counts: "Counts are counts of saved records, not rates, rankings or importance.",
  limitationPeriods: "Two values: the summarized limitation period and whether the saved statute wording agrees. When they differ, the statute controls.",
  people: "Judges and attorneys are identified by native ids only; never merged on a name; litigant names are never published.",
  closedLayer: "A layer answering available:false failed its hash or validation check; report that, do not work around it.",
} as const;

/** Provenance fields a UI or tool result must show for one archive record. */
export type ArchiveProvenance = {
  recordId: string | null;
  layer: string | null;
  sourceUrl: string | null;
  capturedAt: string | null;
  qualification: string | null;
};

/** Extract provenance from the shapes the archive returns (record, area item, document hit). Missing fields stay null; nothing is invented. */
export function provenanceOf(payload: unknown): ArchiveProvenance {
  const o = (payload && typeof payload === "object" ? payload : {}) as Record<string, unknown>;
  const meta = (o["metadata"] && typeof o["metadata"] === "object" ? o["metadata"] : {}) as Record<string, unknown>;
  const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);
  return {
    recordId: str(o["id"]) ?? str(o["record_id"]) ?? str(meta["id"]),
    layer: str(o["layer"]) ?? str(o["supplement"]) ?? str(o["collection"]) ?? str(meta["layer"]),
    sourceUrl: str(o["source_url"]) ?? str(o["url"]) ?? str(meta["source_url"]),
    capturedAt: str(o["captured_at"]) ?? str(o["capture_date"]) ?? str(o["fetched_at"]) ?? str(meta["captured_at"]) ?? str(o["verified_date"]),
    qualification: str(o["qualification"]) ?? str(meta["qualification"]),
  };
}

/** The archive reports a closed layer as {available:false, reason}. */
export function isClosedLayer(payload: unknown): payload is { available: false; reason?: string } {
  return !!payload && typeof payload === "object" && (payload as Record<string, unknown>)["available"] === false;
}
