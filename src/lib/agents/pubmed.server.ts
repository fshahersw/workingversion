// ============================================================================
// PubMed primary-literature client (server-only) for causation science.
//
// NCBI E-utilities, plain HTTPS: esearch (query -> PMIDs) then efetch (PMIDs ->
// article XML with title, journal, year, authors, and ABSTRACT — the part that
// actually decides general/specific causation). No auth required; an optional
// free NCBI_API_KEY raises the rate limit. Self-throttled by the shared memoTTL
// cache in research-tools. No secrets committed.
// ============================================================================

const NCBI_API_KEY = process.env["NCBI_API_KEY"];
const EUTILS = "https://eutils.ncbi.nlm.nih.gov/entrez/eutils";
const TOOL = "seegerweiss-research";

export type PubMedHit = {
  pmid: string;
  title: string;
  journal: string;
  year: string;
  authors: string; // "Smith J, Doe A, et al."
  abstract: string;
  url: string;
};

async function fetchText(
  url: string,
  accept: string,
  signal?: AbortSignal,
  timeoutMs = 20_000,
): Promise<{ ok: boolean; status: number; text: string }> {
  const c = new AbortController();
  const timer = setTimeout(() => c.abort(), timeoutMs);
  if (signal) signal.addEventListener("abort", () => c.abort());
  try {
    const res = await fetch(url, { headers: { Accept: accept }, signal: c.signal });
    const text = await res.text();
    return { ok: res.ok, status: res.status, text };
  } finally {
    clearTimeout(timer);
  }
}

const auth = (): string => (NCBI_API_KEY ? `&api_key=${encodeURIComponent(NCBI_API_KEY)}` : "");

/** Decode the handful of XML entities E-utilities emits, then strip inner tags. */
function clean(x: string): string {
  return x
    .replace(/<[^>]+>/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

function firstMatch(block: string, re: RegExp): string {
  const m = block.match(re);
  return m && m[1] ? clean(m[1]) : "";
}

function parseArticle(block: string): PubMedHit | null {
  const pmid = firstMatch(block, /<PMID\b[^>]*>(\d+)<\/PMID>/);
  if (!pmid) return null;
  const title =
    firstMatch(block, /<ArticleTitle\b[^>]*>([\s\S]*?)<\/ArticleTitle>/) || "(untitled)";
  const journal =
    firstMatch(block, /<Journal\b[\s\S]*?<Title\b[^>]*>([\s\S]*?)<\/Title>/) ||
    firstMatch(block, /<ISOAbbreviation\b[^>]*>([\s\S]*?)<\/ISOAbbreviation>/);
  const year =
    firstMatch(block, /<PubDate\b[^>]*>[\s\S]*?<Year\b[^>]*>(\d{4})<\/Year>/) ||
    firstMatch(block, /<MedlineDate\b[^>]*>(\d{4})/);
  // Abstract may be split into labeled sections; join them in order.
  const parts: string[] = [];
  for (const m of block.matchAll(/<AbstractText\b([^>]*)>([\s\S]*?)<\/AbstractText>/g)) {
    const label = (m[1] || "").match(/Label="([^"]+)"/);
    const body = clean(m[2] ?? "");
    if (body) parts.push(label ? `${label[1]}: ${body}` : body);
  }
  const abstract = parts.join(" ");
  const names: string[] = [];
  for (const m of block.matchAll(
    /<Author\b[\s\S]*?<LastName\b[^>]*>([\s\S]*?)<\/LastName>(?:[\s\S]*?<Initials\b[^>]*>([\s\S]*?)<\/Initials>)?[\s\S]*?<\/Author>/g,
  )) {
    const last = clean(m[1] ?? "");
    const initials = clean(m[2] ?? "");
    if (last) names.push(initials ? `${last} ${initials}` : last);
    if (names.length >= 6) break;
  }
  const authors = names.length
    ? names.slice(0, 3).join(", ") + (names.length > 3 ? ", et al." : "")
    : "";
  return {
    pmid,
    title,
    journal,
    year,
    authors,
    abstract,
    url: `https://pubmed.ncbi.nlm.nih.gov/${pmid}/`,
  };
}

/** Search PubMed and return ranked article records with abstracts. Empty array
 *  on no results; throws only on a hard transport/HTTP error. */
export async function pubmedSearch(
  query: string,
  limit = 5,
  opts?: { signal?: AbortSignal },
): Promise<PubMedHit[]> {
  const retmax = Math.max(1, Math.min(limit, 20));
  const esearchUrl =
    `${EUTILS}/esearch.fcgi?db=pubmed&retmode=json&sort=relevance` +
    `&retmax=${retmax}&term=${encodeURIComponent(query)}&tool=${TOOL}${auth()}`;
  const es = await fetchText(esearchUrl, "application/json", opts?.signal);
  if (!es.ok) throw new Error(`esearch HTTP ${es.status}: ${es.text.slice(0, 160)}`);
  let ids: string[] = [];
  try {
    const j = JSON.parse(es.text) as { esearchresult?: { idlist?: unknown } };
    ids = Array.isArray(j.esearchresult?.idlist)
      ? (j.esearchresult!.idlist as unknown[]).map((x) => String(x)).filter(Boolean)
      : [];
  } catch {
    ids = [];
  }
  if (!ids.length) return [];

  const efetchUrl =
    `${EUTILS}/efetch.fcgi?db=pubmed&retmode=xml&rettype=abstract` +
    `&id=${ids.join(",")}&tool=${TOOL}${auth()}`;
  const ef = await fetchText(efetchUrl, "application/xml", opts?.signal);
  if (!ef.ok) throw new Error(`efetch HTTP ${ef.status}: ${ef.text.slice(0, 160)}`);

  const blocks = ef.text.match(/<PubmedArticle\b[\s\S]*?<\/PubmedArticle>/g) ?? [];
  const byId = new Map<string, PubMedHit>();
  for (const b of blocks) {
    const hit = parseArticle(b);
    if (hit) byId.set(hit.pmid, hit);
  }
  // Preserve esearch relevance order.
  return ids.map((id) => byId.get(id)).filter((h): h is PubMedHit => !!h);
}
