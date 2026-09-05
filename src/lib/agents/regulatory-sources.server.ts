// ============================================================================
// Free primary-source REST clients for mass-tort research (server-only):
//   openFDA         — drug/device adverse events, recalls, labels
//   Federal Register — proposed/final rules, notices
//   eCFR            — the current text of the CFR
// All plain HTTPS + JSON. openFDA takes an optional free api_key (raises quota);
// Federal Register and eCFR need no auth. Self-throttled by the shared memoTTL
// cache in research-tools. No secrets committed.
// ============================================================================

const OPENFDA_KEY = process.env["OPENFDA_API_KEY"];

async function getJson(url: string, signal?: AbortSignal, timeoutMs = 20_000): Promise<Record<string, unknown>> {
  const c = new AbortController();
  const timer = setTimeout(() => c.abort(), timeoutMs);
  if (signal) signal.addEventListener("abort", () => c.abort());
  try {
    const res = await fetch(url, { headers: { Accept: "application/json" }, signal: c.signal });
    const text = await res.text();
    let json: unknown = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* non-JSON */
    }
    if (!res.ok) {
      // openFDA returns {error:{code,message}}; 404 = no matches (not an error we throw on).
      if (res.status === 404) return { results: [] };
      const msg =
        json && typeof json === "object" && "error" in json
          ? JSON.stringify((json as Record<string, unknown>)["error"]).slice(0, 160)
          : text.slice(0, 160);
      throw new Error(`HTTP ${res.status}: ${msg}`);
    }
    return (json ?? {}) as Record<string, unknown>;
  } finally {
    clearTimeout(timer);
  }
}

const qs = (params: Record<string, string | number | undefined>): string => {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && String(v).trim() !== "") p.set(k, String(v));
  }
  return p.toString();
};

const s = (v: unknown): string => (typeof v === "string" ? v : v == null ? "" : String(v));
const arr = (v: unknown): Record<string, unknown>[] =>
  Array.isArray(v) ? (v as Record<string, unknown>[]) : [];
const firstStr = (v: unknown): string => (Array.isArray(v) ? s(v[0]) : s(v));

// --- openFDA ----------------------------------------------------------------

export type FdaEndpoint =
  | "drug/event"
  | "drug/label"
  | "drug/enforcement"
  | "device/event"
  | "device/enforcement";

export type FdaHit = { title: string; date?: string; detail: string; url?: string };

/** Query an openFDA endpoint. `search` is openFDA search syntax, e.g.
 *  'openfda.brand_name:"valsartan"' or 'reason_for_recall:"nitrosamine"'. */
export async function fdaSearch(
  endpoint: FdaEndpoint,
  search: string,
  limit = 5,
  opts?: { signal?: AbortSignal },
): Promise<FdaHit[]> {
  const url = `https://api.fda.gov/${endpoint}.json?${qs({
    search,
    limit: Math.max(1, Math.min(limit, 25)),
    api_key: OPENFDA_KEY,
  })}`;
  const data = await getJson(url, opts?.signal);
  const results = arr(data["results"]);
  return results.map((r) => {
    if (endpoint.endsWith("enforcement")) {
      return {
        title: `${s(r["classification"]) || "Recall"}: ${s(r["product_description"]).slice(0, 120)}`,
        date: s(r["recall_initiation_date"]) || undefined,
        detail: `${s(r["recalling_firm"])} — ${s(r["reason_for_recall"]).slice(0, 300)} (status: ${s(r["status"])})`,
      };
    }
    if (endpoint === "drug/event" || endpoint === "device/event") {
      const patient = (r["patient"] ?? {}) as Record<string, unknown>;
      const reactions = arr(patient["reaction"])
        .map((x) => s(x["reactionmeddrapt"]))
        .filter(Boolean)
        .slice(0, 6)
        .join(", ");
      const drugs = arr(patient["drug"])
        .map((x) => s(x["medicinalproduct"]))
        .filter(Boolean)
        .slice(0, 4)
        .join(", ");
      return {
        title: `Adverse event${drugs ? ` — ${drugs}` : ""}`,
        date: s(r["receivedate"]) || undefined,
        detail: `Reactions: ${reactions || "(unspecified)"}${r["serious"] ? ` · serious=${s(r["serious"])}` : ""}`,
      };
    }
    // drug/label
    const openfda = (r["openfda"] ?? {}) as Record<string, unknown>;
    const name = firstStr(openfda["brand_name"]) || firstStr(openfda["generic_name"]) || "Label";
    const warnings = (firstStr(r["boxed_warning"]) || firstStr(r["warnings"]) || firstStr(r["indications_and_usage"])).slice(0, 300);
    return { title: `Label: ${name}`, detail: warnings || "(no warning text)" };
  });
}

// --- Federal Register -------------------------------------------------------

export type FedRegHit = {
  title: string;
  documentNumber: string;
  date: string;
  type: string;
  agencies: string[];
  url: string;
  abstract?: string;
};

export async function fedRegSearch(
  term: string,
  opts?: { type?: string; after?: string; signal?: AbortSignal },
): Promise<FedRegHit[]> {
  const p = new URLSearchParams();
  p.set("conditions[term]", term);
  p.set("per_page", "10");
  p.set("order", "relevance");
  for (const f of ["title", "document_number", "publication_date", "type", "agencies", "html_url", "abstract"]) {
    p.append("fields[]", f);
  }
  if (opts?.type) p.set("conditions[type][]", opts.type);
  if (opts?.after) p.set("conditions[publication_date][gte]", opts.after);
  const data = await getJson(`https://www.federalregister.gov/api/v1/documents.json?${p.toString()}`, opts?.signal);
  return arr(data["results"]).map((r) => ({
    title: s(r["title"]),
    documentNumber: s(r["document_number"]),
    date: s(r["publication_date"]),
    type: s(r["type"]),
    agencies: arr(r["agencies"]).map((a) => s(a["name"])).filter(Boolean),
    url: s(r["html_url"]),
    abstract: s(r["abstract"]).slice(0, 300) || undefined,
  }));
}

// --- eCFR (current CFR text) ------------------------------------------------

export type EcfrHit = { heading: string; excerpt: string; hierarchy: string };

export async function ecfrSearch(
  query: string,
  opts?: { signal?: AbortSignal },
): Promise<EcfrHit[]> {
  const data = await getJson(
    `https://www.ecfr.gov/api/search/v1/results?${qs({ query, per_page: 10 })}`,
    opts?.signal,
  );
  return arr(data["results"]).map((r) => {
    const headings = (r["hierarchy_headings"] ?? {}) as Record<string, unknown>;
    const hierarchy = [s(headings["title"]), s(headings["part"]), s(headings["section"])].filter(Boolean).join(" › ");
    return {
      heading: s(r["hierarchy_headings"] && headings["section"]) || s(r["label"]) || hierarchy || "CFR section",
      excerpt: s(r["full_text_excerpt"]).replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim().slice(0, 300),
      hierarchy,
    };
  });
}
