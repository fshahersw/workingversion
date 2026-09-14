// Server-only readers/writers for the litigation intelligence feed and the
// corpus-backed signal tabs on the home terminal.
import { corpusUrl } from "@/lib/corpus";
import { toRow, type IntelFeed, type IntelRow } from "@/lib/intel-schema";
import type {
  CorpusSignal,
  IntelFeedPage,
  IntelItem,
  IntelPrimarySource,
  IntelStatus,
} from "@/lib/intel-types";

type Row = Record<string, unknown>;

function key(): string {
  const k = process.env["CORPUS_SERVICE_KEY"];
  if (!k) throw new Error("Corpus key not configured");
  return k;
}

async function rest(path: string, init: RequestInit = {}): Promise<Response> {
  const k = key();
  return fetch(`${corpusUrl()}/rest/v1/${path}`, {
    ...init,
    headers: {
      apikey: k,
      Authorization: `Bearer ${k}`,
      "content-type": "application/json",
      ...(init.headers as Record<string, string> | undefined),
    },
  });
}

async function select(table: string, params: Record<string, string>): Promise<Row[]> {
  const qs = new URLSearchParams(params).toString();
  const res = await rest(`${table}?${qs}`);
  if (!res.ok) throw new Error(`Corpus ${table}: ${res.status} ${await res.text()}`);
  return (await res.json()) as Row[];
}

const s = (v: unknown): string => (typeof v === "string" ? v : typeof v === "number" ? String(v) : "");
const sn = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v : null);
const nn = (v: unknown): number => (typeof v === "number" ? v : 0);

// ------------------------------------------------------------------ write --

/** Tag items that mention a matter we actually hold, so rows can deep-link. */
async function attachMatters(rows: IntelRow[]): Promise<void> {
  let matters: Row[];
  try {
    matters = await select("corpus_matters", {
      select: "slug,short_name,case_name,docket_number,mdl_number",
      limit: "2000",
    });
  } catch {
    return;
  }
  const needles = matters
    .map((m) => {
      const label = sn(m["short_name"]) ?? s(m["case_name"]);
      const mdl = sn(m["mdl_number"]);
      const terms: string[] = [];
      // Distinctive leading token of the case name ("In re: Talc …" -> "talc").
      const core = label
        .replace(/^in re:?\s*/i, "")
        .replace(/\b(products?|liability|litigation|marketing|sales|practices|mdl|inc\.?|llc)\b/gi, " ")
        .trim();
      const first = core.split(/[\s,]+/).filter((w) => w.length > 4)[0];
      if (first) terms.push(first.toLowerCase());
      if (mdl) terms.push(`mdl ${mdl.replace(/^mdl\s*/i, "")}`.toLowerCase());
      return { slug: s(m["slug"]), label, terms: terms.filter(Boolean) };
    })
    .filter((m) => m.slug && m.terms.length);

  for (const row of rows) {
    const hay = `${row.title} ${row.summary ?? ""}`.toLowerCase();
    const hit = needles.find((m) => m.terms.some((t) => hay.includes(t)));
    if (hit) {
      row.matter_slug = hit.slug;
      row.matter_label = hit.label;
      row.signal_score = Math.min(100, row.signal_score + 8);
    }
  }
}

export async function ingestFeed(feed: IntelFeed): Promise<Record<string, unknown>> {
  const receivedAt = new Date().toISOString();
  const rows = feed.items.map((i) => toRow(i, receivedAt));
  await attachMatters(rows);

  const res = await rest("rpc/intel_ingest", {
    method: "POST",
    body: JSON.stringify({
      payload: {
        generated_at: feed.generatedAt ?? receivedAt,
        schema_version: feed.schemaVersion ?? null,
        stats: feed.stats ?? {},
        errors: feed.errors ?? {},
        retain_days: feed.retainDays ?? 90,
        items: rows,
      },
    }),
  });
  if (!res.ok) throw new Error(`intel_ingest: ${res.status} ${await res.text()}`);
  return (await res.json()) as Record<string, unknown>;
}

// ------------------------------------------------------------------- read --

function toItem(r: Row): IntelItem {
  const primary = Array.isArray(r["primary_sources"]) ? (r["primary_sources"] as Row[]) : [];
  return {
    id: s(r["intel_id"]),
    category: s(r["category"]) || "News",
    title: s(r["title"]),
    url: s(r["url"]),
    summary: sn(r["summary"]),
    sourceDomain: sn(r["source_domain"]),
    sourceName: sn(r["source_name"]),
    faviconUrl: sn(r["favicon_url"]),
    imageUrl: sn(r["image_url"]),
    imageKind: sn(r["image_kind"]),
    imageAlt: sn(r["image_alt"]),
    signalScore: Math.round(nn(r["signal_score"])),
    paywall: sn(r["paywall"]),
    rights: sn(r["rights"]),
    publishedAt: sn(r["published_at"]),
    fetchedAt: sn(r["fetched_at"]),
    relatedTopics: Array.isArray(r["related_topics"]) ? (r["related_topics"] as string[]) : [],
    matterSlug: sn(r["matter_slug"]),
    matterLabel: sn(r["matter_label"]),
    primarySources: primary
      .map((p): IntelPrimarySource => ({
        title: sn(p["title"]) ?? s(p["url"]),
        url: s(p["url"]),
        domain: sn(p["domain"]),
        summary: sn(p["summary"]),
      }))
      .filter((p) => p.url),
    analysisLead: sn(r["analysis_lead"]),
    bullets: Array.isArray(r["analysis_bullets"]) ? (r["analysis_bullets"] as string[]) : [],
    impact: sn(r["analysis_impact"]),
  };
}

const ITEM_COLS =
  "intel_id,category,title,url,summary,source_domain,source_name,favicon_url," +
  "image_url,image_kind,image_alt,signal_score,paywall,rights,published_at," +
  "fetched_at,related_topics,matter_slug,matter_label,primary_sources,run_id," +
  "analysis_lead,analysis_bullets,analysis_impact";

/** Feed categories → the pipeline `category` values they cover. */
const CATEGORY_MAP: Record<string, string[]> = {
  news: ["News", "Verdict", "Order", "Opinion", "Settlement", "Regulatory", "Enforcement"],
  courts: ["Order", "Opinion", "Verdict"],
  agencies: ["Enforcement", "Regulatory"],
  research: ["Research"],
  settlements: ["Settlement"],
  commentary: ["Commentary"],
  // Corpus-backed tabs blend our own records with the wider litigation wire so
  // they are never limited to the handful of matters we happen to hold.
  mdl: ["News", "Verdict", "Settlement", "Order", "Opinion"],
  filings: ["Order", "Opinion", "Verdict", "News"],
  alerts: ["Regulatory", "Enforcement", "News"],
};

/** Extra topical gate for the blended corpus tabs. */
const SECTION_KEYWORDS: Record<string, RegExp> = {
  mdl: /\b(mdl|multidistrict|mass tort|bellwether|jpml|class action|steering committee|common benefit|consolidat)/i,
  filings: /\b(order|ruling|opinion|motion|filed|complaint|sanction|discovery|daubert|summary judgment|remand|dismiss|certif)/i,
  alerts: /\b(recall|warning letter|safety|enforcement|subpoena|investigation|rule|deadline|injunction|consent decree)/i,
};


/** Keep the highest-ranked feed while preventing one publisher owning the page. */
function diversifyRows(rows: Row[], limit: number): Row[] {
  const buckets = new Map<string, Row[]>();
  for (const row of rows) {
    const domain = sn(row["source_domain"]) ?? "unknown";
    const bucket = buckets.get(domain) ?? [];
    bucket.push(row);
    buckets.set(domain, bucket);
  }
  const output: Row[] = [];
  while (output.length < limit) {
    let added = false;
    for (const bucket of buckets.values()) {
      const row = bucket.shift();
      if (!row) continue;
      output.push(row);
      added = true;
      if (output.length >= limit) break;
    }
    if (!added) break;
  }
  return output;
}


export async function loadIntelFeed(input: {
  section: string;
  search?: string;
  limit?: number;
}): Promise<IntelFeedPage> {
  const limit = Math.min(input.limit ?? 60, 200);
  const cats = CATEGORY_MAP[input.section];
  const params: Record<string, string> = {
    select: ITEM_COLS,
    order: "signal_score.desc,published_at.desc",
    limit: String(Math.min(limit * 4, 500)),
  };
  // Publish only stories that passed the QA gate. Older/external rows without a
  // verdict default to "approved" at ingest, so nothing is hidden retroactively.
  params["review_status"] = "eq.approved";
  if (cats?.length) params["category"] = `in.(${cats.map((c) => `"${c}"`).join(",")})`;
  const q = input.search?.trim();
  if (q) {
    const esc = q.replace(/[%,()]/g, " ").trim();
    if (esc) params["or"] = `(title.ilike.*${esc}*,summary.ilike.*${esc}*,source_domain.ilike.*${esc}*)`;
  }

  let rows: Row[] = [];
  try {
    const latestRuns = await select("corpus_intel_runs", {
      select: "run_id",
      order: "generated_at.desc",
      limit: "1",
    });
    const latestRunId = sn(latestRuns[0]?.["run_id"]);
    if (latestRunId) params["run_id"] = `eq.${latestRunId}`;
    rows = await select("corpus_intel_items", params);
  } catch {
    // Tolerate a corpus that has not had the QA migration applied yet: retry
    // without the review filter so the terminal still populates. Pre-migration
    // this is the prior (ungated) behavior; once the column exists the filter
    // above succeeds and the QA gate is live — no deploy-ordering dependency.
    delete params["review_status"];
    try {
      rows = await select("corpus_intel_items", params);
    } catch {
      rows = [];
    }
  }
  const gate = SECTION_KEYWORDS[input.section];
  if (gate && rows.length > 0) {
    const focused = rows.filter((r) => gate.test(`${s(r["title"])} ${s(r["summary"])}`));
    if (focused.length >= 8) rows = focused;
  }

  if (rows.length === 0 && input.section === "news") {
    // No ETL feed yet — fall back to the curated static headlines.
    const { STATIC_HEADLINES } = await import("./news-static");
    const q = input.search?.trim().toLowerCase();
    return {
      items: STATIC_HEADLINES
        .filter((h) => !q || `${h.title} ${h.snippet ?? ""}`.toLowerCase().includes(q))
        .slice(0, limit)
        .map((h) => ({
          id: h.id,
          category: "News",
          title: h.title,
          url: h.url,
          summary: h.snippet,
          sourceDomain: h.source_domain,
          sourceName: h.source_domain,
          faviconUrl: h.source_domain ? `https://icons.duckduckgo.com/ip3/${h.source_domain}.ico` : null,
          imageUrl: h.image_url,
          imageKind: h.image_url ? "editorial" : null,
          imageAlt: null,
          signalScore: 50,
          paywall: null,
          rights: null,
          publishedAt: h.published_at,
          fetchedAt: h.fetched_at,
          relatedTopics: [],
          matterSlug: null,
          matterLabel: null,
          primarySources: [],
          analysisLead: null,
          bullets: [],
          impact: null,
        })),
    };
  }
  return { items: diversifyRows(rows, limit).map(toItem) };
}


export async function loadIntelStatus(): Promise<IntelStatus> {
  try {
    const [runs, counts] = await Promise.all([
      select("corpus_intel_runs", {
        select: "generated_at,received_at,item_count,inserted,updated,errors",
        order: "generated_at.desc",
        limit: "1",
      }),
      select("corpus_intel_items", { select: "category" , limit: "1000" }),
    ]);
    const run = runs[0];
    const errors = (run?.["errors"] ?? {}) as Record<string, unknown>;
    const errCount =
      (Array.isArray(errors["search"]) ? errors["search"].length : 0) +
      (Array.isArray(errors["scrape"]) ? errors["scrape"].length : 0);
    const byCategory: Record<string, number> = {};
    for (const c of counts) {
      const k = s(c["category"]) || "News";
      byCategory[k] = (byCategory[k] ?? 0) + 1;
    }
    return {
      lastRunAt: sn(run?.["generated_at"]) ?? sn(run?.["received_at"]),
      itemCount: counts.length,
      errorCount: errCount,
      byCategory,
      healthy: Boolean(run) && errCount === 0,
    };
  } catch {
    return { lastRunAt: null, itemCount: 0, errorCount: 0, byCategory: {}, healthy: false };
  }
}

// ------------------------------------------------------- corpus-backed tabs --

async function matterIndex(): Promise<Map<string, { slug: string; label: string }>> {
  const rows = await select("corpus_matters", {
    select: "matter_id,slug,short_name,case_name",
    limit: "2000",
  });
  const map = new Map<string, { slug: string; label: string }>();
  for (const r of rows) {
    map.set(s(r["matter_id"]), {
      slug: s(r["slug"]),
      label: sn(r["short_name"]) ?? s(r["case_name"]),
    });
  }
  return map;
}

/** MDL / Mass Tort tab: the matters we hold, ranked by docket volume. */
export async function loadMatterSignals(limit = 40): Promise<CorpusSignal[]> {
  const rows = await select("corpus_matters", {
    select:
      "matter_id,slug,short_name,case_name,docket_number,court_name,court_id,judge,status,mdl_number,date_filed,node_role",
    order: "date_filed.desc.nullslast",
    limit: String(limit),
  });
  return rows.map((r): CorpusSignal => {
    const label = sn(r["short_name"]) ?? s(r["case_name"]);
    return {
      id: s(r["matter_id"]),
      kind: "matter",
      title: label,
      detail: [sn(r["court_name"]) ?? s(r["court_id"]), sn(r["docket_number"])]
        .filter(Boolean)
        .join(" · "),
      badge: sn(r["mdl_number"]) ? `MDL ${s(r["mdl_number"]).replace(/^MDL\s*/i, "")}` : sn(r["node_role"]),
      timestamp: sn(r["date_filed"]),
      matterSlug: s(r["slug"]),
      matterLabel: label,
      meta: [sn(r["judge"]), sn(r["status"])].filter(Boolean) as string[],
      bullets: [],
      impact: null,
    };
  });
}

/** Filings & Orders tab: the newest docket entries across the whole corpus. */
type DocketBrief = { bullets: string[]; impact: string | null };

/** Cached AI briefings for docket entries, keyed by entry id. */
async function docketAnalysis(ids: string[]): Promise<Map<string, DocketBrief>> {
  const map = new Map<string, DocketBrief>();
  if (ids.length === 0) return map;
  try {
    const rows = await select("corpus_docket_analysis", {
      select: "docket_entry_id,lead,bullets,impact",
      docket_entry_id: `in.(${ids.slice(0, 200).join(",")})`,
      limit: "200",
    });
    for (const r of rows) {
      map.set(s(r["docket_entry_id"]), {
        bullets: Array.isArray(r["bullets"]) ? (r["bullets"] as string[]) : [],
        impact: sn(r["impact"]),
      });
    }
  } catch {
    return map;
  }
  return map;
}

export async function loadFilingSignals(limit = 60): Promise<CorpusSignal[]> {
  const [rows, matters] = await Promise.all([
    select("corpus_docket_entries", {
      select: "docket_entry_id,matter_id,entry_number,date_filed,description,entry_type,has_pdf,document_count",
      order: "date_filed.desc.nullslast",
      limit: String(Math.min(limit, 200)),
    }),
    matterIndex(),
  ]);
  const analysis = await docketAnalysis(rows.map((r) => s(r["docket_entry_id"])).filter(Boolean));
  return rows.map((r): CorpusSignal => {
    const m = matters.get(s(r["matter_id"]));
    const num = r["entry_number"];
    const desc = s(r["description"]).replace(/\s+/g, " ").trim();
    return {
      id: s(r["docket_entry_id"]),
      kind: "filing",
      title: desc.slice(0, 240) || "(no description)",
      detail: m?.label ?? "",
      badge: typeof num === "number" && num < 100000 ? `#${num}` : sn(r["entry_type"]),
      timestamp: sn(r["date_filed"]),
      matterSlug: m?.slug ?? null,
      matterLabel: m?.label ?? null,
      meta: [
        r["has_pdf"] === true ? "PDF" : null,
        nn(r["document_count"]) ? `${nn(r["document_count"])} docs` : null,
      ].filter(Boolean) as string[],
      bullets: analysis.get(s(r["docket_entry_id"]))?.bullets ?? [],
      impact: analysis.get(s(r["docket_entry_id"]))?.impact ?? null,
    };
  });
}

/** Alerts tab: ingestion runs that need a human look. */
export async function loadAlertSignals(limit = 40): Promise<CorpusSignal[]> {
  const rows = await select("corpus_ingest_runs", {
    select: "run_id,slug,stage,status,detail,started_at,finished_at",
    order: "started_at.desc",
    limit: String(Math.min(limit, 100)),
  });
  return rows
    .filter((r) => {
      const st = s(r["status"]).toLowerCase();
      return st !== "done" && st !== "completed" && st !== "ok";
    })
    .map((r): CorpusSignal => ({
      id: s(r["run_id"]),
      kind: "alert",
      title: `${s(r["slug"])} — ${s(r["status"]) || "unknown"}`,
      detail: s(r["stage"]) ? `stage: ${s(r["stage"])}` : "",
      badge: s(r["status"]),
      timestamp: sn(r["started_at"]),
      matterSlug: s(r["slug"]) || null,
      matterLabel: s(r["slug"]) || null,
      meta: r["detail"] ? [JSON.stringify(r["detail"]).slice(0, 160)] : [],
      bullets: [],
      impact: null,
    }));
}

export async function loadCorpusSignals(section: string): Promise<CorpusSignal[]> {
  try {
    if (section === "mdl") return await loadMatterSignals();
    if (section === "filings") return await loadFilingSignals();
    if (section === "alerts") return await loadAlertSignals();
  } catch {
    return [];
  }
  return [];
}

// --------------------------------------------------- cached docket briefings --

/**
 * Generate and cache plain-language briefings for the newest docket entries
 * that don't have one yet. Runs inside the intelligence run; never throws.
 */
export async function refreshDocketAnalysis(limit = 60): Promise<{ analyzed: number; errors: string[] }> {
  try {
    const [entries, existing, matters] = await Promise.all([
      select("corpus_docket_entries", {
        select: "docket_entry_id,matter_id,entry_number,date_filed,description,entry_type",
        order: "date_filed.desc.nullslast",
        limit: String(Math.min(limit * 2, 200)),
      }),
      select("corpus_docket_analysis", { select: "docket_entry_id", limit: "1000" }),
      matterIndex(),
    ]);
    const done = new Set(existing.map((r) => s(r["docket_entry_id"])));
    const todo = entries.filter((r) => !done.has(s(r["docket_entry_id"]))).slice(0, limit);
    if (todo.length === 0) return { analyzed: 0, errors: [] };

    const { analyzeItems } = await import("@/lib/intel-analyze.server");
    const { analyses, errors } = await analyzeItems(
      todo.map((r) => ({
        key: s(r["docket_entry_id"]),
        title: s(r["description"]).slice(0, 400) || "Docket entry",
        source: matters.get(s(r["matter_id"]))?.label ?? null,
        text: [
          matters.get(s(r["matter_id"]))?.label,
          sn(r["entry_type"]),
          sn(r["date_filed"]),
          s(r["description"]),
        ]
          .filter(Boolean)
          .join(" · "),
      })),
      { cap: limit, batchSize: 8, concurrency: 3 },
    );
    if (analyses.size === 0) return { analyzed: 0, errors };

    const payload = [...analyses.entries()].map(([id, a]) => ({
      docket_entry_id: id,
      lead: a.lead,
      bullets: a.bullets,
      impact: a.impact,
      generated_at: new Date().toISOString(),
    }));
    const res = await rest("corpus_docket_analysis", {
      method: "POST",
      headers: { Prefer: "return=minimal" },
      body: JSON.stringify(payload),
    });
    if (!res.ok) errors.push(`docket analysis write: ${res.status} ${(await res.text()).slice(0, 160)}`);
    return { analyzed: payload.length, errors };
  } catch (e) {
    return { analyzed: 0, errors: [e instanceof Error ? e.message : String(e)] };
  }
}
