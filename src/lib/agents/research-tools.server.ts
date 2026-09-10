// ============================================================================
// Unified tool set for the single research agent (server-only).
//
// Reuses the existing, battle-tested search + DocketBird tools (executeTool in
// tools.server) and ADDS fetch_page (read a primary source in full) and
// verify_citations (confirm a reporter cite against CourtListener's opinion DB).
// One flat tool list, one executor, one shared SourceBook so [S#] refs stay
// stable across the whole run.
// ============================================================================
import type { ToolDef } from "./anthropic.server";
import { AGENT_TOOLS, SourceBook, executeTool, type ToolOutcome } from "./tools.server";
import { fetchPage } from "./fetch-page.server";
import { memoTTL, toolCacheKey, TOOL_CACHE_TTL_MS } from "./run-state.server";
import { courtlistenerConfigured, lookupCitations } from "./courtlistener.server";
import {
  fdaSearch,
  fedRegSearch,
  ecfrSearch,
  secSearch,
  clinicalTrialsSearch,
  type FdaEndpoint,
} from "./regulatory-sources.server";
import { pubmedSearch } from "./pubmed.server";
import { runPython, collectNewArtifacts, readDocument } from "./code-interpreter.server";
import { searchMarkdownKey } from "./bda.server";
import { generateDocument } from "./docgen.server";
import type { Artifact, Attachment } from "@/lib/chat-types";

const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");
const trunc = (v: string, n: number) => (v.length > n ? `${v.slice(0, n)}…` : v);
const clamp = (v: unknown, def: number, max: number) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.min(Math.floor(n), max) : def;
};

// --- New tool definitions --------------------------------------------------

const FETCH_PAGE_TOOL: ToolDef = {
  name: "fetch_page",
  description:
    "Fetch a URL and read its main text + outbound links as clean text. Use to READ a primary source in full — a court opinion page, an agency rule, a news article, a docket page — after a search surfaces it. Reading the actual page beats reasoning from a search snippet. For a court FILING's text, prefer db_read_filing.",
  input_schema: {
    type: "object",
    properties: { url: { type: "string", description: "Absolute http(s) URL to fetch and read." } },
    required: ["url"],
  },
};

const VERIFY_CITATIONS_TOOL: ToolDef = {
  name: "verify_citations",
  description:
    "Verify reporter-style legal citations (e.g. '576 U.S. 644', '2023 WL 12345', F.3d / F. Supp. 3d) against CourtListener's opinion database. Pass a block of TEXT (a paragraph of your draft, or a list of cites) and each citation resolves to a real case or is flagged not-found / ambiguous. Use to CONFIRM a case citation is real before you rely on it. For docket/PACER filings use db_* instead.",
  input_schema: {
    type: "object",
    properties: { text: { type: "string", description: "Text containing one or more legal citations to resolve." } },
    required: ["text"],
  },
};

const FDA_SEARCH_TOOL: ToolDef = {
  name: "fda_search",
  description:
    "Query openFDA for STRUCTURED FDA data. endpoint: 'drug/enforcement' or 'device/enforcement' (recalls — classification, reason, firm, date), 'drug/event' or 'device/event' (adverse-event reports — reactions, seriousness), 'drug/label' (labeling — boxed warnings, indications). search is openFDA syntax, e.g. openfda.brand_name:\"valsartan\" or reason_for_recall:\"nitrosamine\". Use for recalls, adverse-event signals, and label/warning history in a drug or device mass tort.",
  input_schema: {
    type: "object",
    properties: {
      endpoint: {
        type: "string",
        enum: ["drug/event", "drug/label", "drug/enforcement", "device/event", "device/enforcement"],
      },
      search: { type: "string", description: 'openFDA search expression, e.g. field:"value".' },
    },
    required: ["endpoint", "search"],
  },
};

const FED_REGISTER_TOOL: ToolDef = {
  name: "federal_register_search",
  description:
    "Search the Federal Register for proposed/final RULES and agency notices (title, agency, date, document number, abstract, link) — the regulatory action itself (a proposed ban, a final rule, a guidance notice). Optional type (RULE | PRORULE | NOTICE) and after (YYYY-MM-DD).",
  input_schema: {
    type: "object",
    properties: {
      term: { type: "string" },
      type: { type: "string", description: "RULE | PRORULE | NOTICE (optional)" },
      after: { type: "string", description: "YYYY-MM-DD; only documents on/after (optional)" },
    },
    required: ["term"],
  },
};

const ECFR_TOOL: ToolDef = {
  name: "ecfr_search",
  description:
    "Search the current text of the Code of Federal Regulations (eCFR) — the operative regulatory TEXT (e.g. 21 CFR drug/device rules). Returns matching sections with their hierarchy and a text excerpt. Put the CFR title in the query text (e.g. '21 CFR device recall') to bias results.",
  input_schema: {
    type: "object",
    properties: {
      query: { type: "string" },
    },
    required: ["query"],
  },
};

const PUBMED_TOOL: ToolDef = {
  name: "search_pubmed",
  description:
    "Search PubMed for PRIMARY peer-reviewed biomedical literature (epidemiology, clinical studies, meta-analyses, toxicology) with abstracts. This is the authoritative source for GENERAL and SPECIFIC CAUSATION — use it for whether an exposure causes a disease, study design/quality, dose-response, relative risk / odds ratios, and an expert witness's own publication record. Prefer this over web search for the science. Query with distinctive terms (agent + disease + design), e.g. 'talc perineal ovarian cancer cohort' or 'glyphosate non-Hodgkin lymphoma meta-analysis'.",
  input_schema: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description:
          "PubMed query — exposure/agent + disease/outcome + optional study type. Distinctive medical terms, not a sentence.",
      },
      limit: { type: "number", description: "Max articles (default 5, hard cap 20)." },
    },
    required: ["query"],
  },
};

const SEC_SEARCH_TOOL: ToolDef = {
  name: "sec_search",
  description:
    "Full-text search of SEC EDGAR filings (10-K, 10-Q, 8-K, proxy statements, prospectuses). Use to find what a PUBLIC-COMPANY DEFENDANT disclosed in its OWN filings — product risks and warnings, litigation reserves and contingencies, recalls, regulatory actions, financial condition. Query the company name plus a topic (e.g. 'Bayer glyphosate litigation reserve', 'Philips Respironics recall'). Optional forms filter (e.g. '10-K') and after (YYYY-MM-DD). Primary corporate disclosure — outranks news reporting of it.",
  input_schema: {
    type: "object",
    properties: {
      query: { type: "string", description: "Company + topic terms (a distinctive phrase works best)." },
      forms: { type: "string", description: "Optional SEC form-type filter, e.g. '10-K' or '8-K'." },
      after: { type: "string", description: "Optional YYYY-MM-DD; only filings on/after this date." },
    },
    required: ["query"],
  },
};

const CLINICALTRIALS_TOOL: ToolDef = {
  name: "clinicaltrials_search",
  description:
    "Search ClinicalTrials.gov (the NIH trial registry) for clinical trials of a drug or device — trial status, phase, lead sponsor, conditions studied, and start date. Use in a drug/device mass tort for what trials exist for a product, who sponsored them, the indication/population studied, and trial timing relative to marketing or a known risk. Query the drug/device plus condition (e.g. 'semaglutide gastroparesis', 'Bard hernia mesh adhesion'). Complements search_pubmed (published results) with the registry record.",
  input_schema: {
    type: "object",
    properties: {
      query: { type: "string", description: "Drug/device + condition terms." },
      limit: { type: "number", description: "Max studies (default 5, hard cap 20)." },
    },
    required: ["query"],
  },
};

const RUN_PYTHON_TOOL: ToolDef = {
  name: "run_python",
  description:
    "Run Python in a secure sandbox (pandas, numpy, matplotlib, python-dateutil preinstalled; NO internet). Use for exact CALCULATIONS the answer must not get wrong: settlement allocation / net-to-claimant waterfalls (use decimal.Decimal for money), limitations/repose date math (dateutil.relativedelta), aggregating or de-duping data you paste inline (pandas), statistics, and numeric sanity checks. Put the input data DIRECTLY in the code — the sandbox cannot fetch anything — and print() what you need back. Do NOT use it for legal reasoning, retrieval, or web access.",
  input_schema: {
    type: "object",
    properties: { code: { type: "string", description: "Python source to execute. Include input data inline; print() the results." } },
    required: ["code"],
  },
};

const READ_DOCUMENT_TOOL: ToolDef = {
  name: "read_document",
  description:
    "Retrieve passages from a file the ATTORNEY UPLOADED this session (only for uploads flagged as having a searchable full text — small uploads are already shown to you in full in the UPLOADED FILES block). Pass the exact file name plus a query of keywords; returns the best-matching passages from the full document. Use this to pull the specific parts of a long uploaded PDF/brief/report you need to answer, instead of guessing or relying on the preview.",
  input_schema: {
    type: "object",
    properties: {
      name: { type: "string", description: "Exact uploaded file name (as shown in UPLOADED FILES)." },
      query: { type: "string", description: "Keywords describing the passage you need (e.g. 'causation expert Daubert')." },
    },
    required: ["name", "query"],
  },
};

const CREATE_DOCUMENT_TOOL: ToolDef = {
  name: "create_document",
  description:
    "Produce a polished, downloadable DOCX / XLSX / PDF deliverable for the attorney (memo, report, chart pack, or spreadsheet). Provide the body as MARKDOWN: '#'/'##' headings, '-' bullets, '1.' numbered lists, and pipe tables (| Col | Col |\\n|---|---|\\n| ... |) — tables render as real Word/Excel/PDF tables, sized and styled. For a diagram, include a fenced code block tagged `dot` containing Graphviz DOT (flowcharts, timelines, org/relationship charts); it is rendered to an image and embedded. Pick format: 'pdf' for memos/reports (cover page + page numbers), 'docx' for an editable Word document, or 'xlsx' when the content is primarily tables/data. Only call this when the attorney explicitly wants a file to download — ordinary answers stay in chat.",
  input_schema: {
    type: "object",
    properties: {
      format: { type: "string", enum: ["pdf", "docx", "xlsx"], description: "Output file format." },
      title: { type: "string", description: "Document title (used on the cover page)." },
      content: { type: "string", description: "Markdown body (headings, tables, lists, ```dot diagrams)." },
      style: { type: "string", enum: ["legal", "modern", "minimal"], description: "Visual style — 'legal' (navy/serif, default), 'modern' (teal/sans), or 'minimal' (understated)." },
      filename: { type: "string", description: "Optional base filename (extension added automatically)." },
    },
    required: ["format", "title", "content"],
  },
};

/** The full flat tool list the single agent sees. */
export const RESEARCH_TOOLS: ToolDef[] = [
  ...AGENT_TOOLS.legal_research, // the single web_search tool (16 category domain-sets + general_web)
  FETCH_PAGE_TOOL,
  VERIFY_CITATIONS_TOOL,
  FDA_SEARCH_TOOL,
  FED_REGISTER_TOOL,
  ECFR_TOOL,
  PUBMED_TOOL,
  SEC_SEARCH_TOOL,
  CLINICALTRIALS_TOOL,
  RUN_PYTHON_TOOL,
  READ_DOCUMENT_TOOL,
  CREATE_DOCUMENT_TOOL,
  ...AGENT_TOOLS.docket_research, // db_find_case, db_docket_sheet, db_read_filing, ...
];

// --- New tool handlers -----------------------------------------------------

async function fetchPageTool(input: Record<string, unknown>, book: SourceBook): Promise<ToolOutcome> {
  const url = str(input["url"]);
  if (!/^https?:\/\//i.test(url)) return { text: "Provide an absolute http(s) url.", hits: 0, refs: [] };
  try {
    const p = await memoTTL(toolCacheKey("fetch_page", { url }), TOOL_CACHE_TTL_MS, () => fetchPage(url, { maxChars: 6000 }));
    if (p.note && !p.text) return { text: `${url}: ${p.note}`, hits: 0, refs: [] };
    if (!p.text.trim()) return { text: `No readable text extracted from ${url} (status ${p.status}).`, hits: 0, refs: [] };
    const src = book.add({
      citation: p.title || p.finalUrl,
      authority: "web",
      source_type: "web",
      source_url: p.finalUrl,
      content: trunc(p.text, 1500),
    });
    const links = p.links.slice(0, 12).map((l) => `- ${l.text || l.href} — ${l.href}`).join("\n");
    return {
      text: `[${src.ref}] ${p.title || p.finalUrl}\n${trunc(p.text, 3500)}${links ? `\n\nLINKS:\n${links}` : ""}`,
      hits: 1,
      refs: [src.ref],
    };
  } catch (err) {
    return { text: `fetch_page failed: ${trunc(err instanceof Error ? err.message : "error", 200)}`, hits: 0, refs: [] };
  }
}

async function verifyCitationsTool(input: Record<string, unknown>, book: SourceBook): Promise<ToolOutcome> {
  if (!courtlistenerConfigured()) return { text: "Citation lookup is not configured (COURTLISTENER_API_TOKEN missing).", hits: 0, refs: [] };
  const text = str(input["text"]);
  if (text.trim().length < 3) return { text: "Provide text containing at least one citation.", hits: 0, refs: [] };
  let results;
  try {
    results = await memoTTL(toolCacheKey("verify_citations", { text }), TOOL_CACHE_TTL_MS, () => lookupCitations(text));
  } catch (err) {
    return { text: `verify_citations failed: ${trunc(err instanceof Error ? err.message : "error", 200)}`, hits: 0, refs: [] };
  }
  if (!results.length) return { text: "No recognizable legal citations were found in that text.", hits: 0, refs: [] };
  const refs: string[] = [];
  const lines = results.map((r) => {
    if (r.found) {
      const src = book.add({
        citation: `${r.caseName || r.citation} (${r.citation})`,
        authority: "primary",
        source_type: "opinion",
        source_url: r.url ?? undefined,
        content: `Verified opinion: ${r.caseName || "(unnamed)"} — ${r.citation}`,
      });
      refs.push(src.ref);
      return `[${src.ref}] CONFIRMED  ${r.citation} -> ${r.caseName || "(opinion)"}`;
    }
    if (r.ambiguous) return `AMBIGUOUS  ${r.citation} (multiple matches — narrow it)`;
    return `NOT FOUND  ${r.citation} (status ${r.status} — do not rely on this cite without confirming)`;
  });
  const confirmed = results.filter((r) => r.found).length;
  return {
    text: `Citation check — ${confirmed}/${results.length} confirmed against CourtListener:\n${lines.join("\n")}`,
    hits: confirmed,
    refs,
  };
}

async function fdaSearchTool(input: Record<string, unknown>, book: SourceBook): Promise<ToolOutcome> {
  const endpoint = str(input["endpoint"]);
  const search = str(input["search"]);
  if (!endpoint || !search) return { text: "fda_search needs an endpoint and a search expression.", hits: 0, refs: [] };
  let hits;
  try {
    hits = await memoTTL(toolCacheKey("fda_search", { endpoint, search }), TOOL_CACHE_TTL_MS, () =>
      fdaSearch(endpoint as FdaEndpoint, search, 5),
    );
  } catch (err) {
    return { text: `fda_search failed: ${trunc(err instanceof Error ? err.message : "error", 200)}`, hits: 0, refs: [] };
  }
  if (!hits.length) return { text: `No openFDA results for ${endpoint} "${search}".`, hits: 0, refs: [] };
  const refs: string[] = [];
  const lines = hits.map((h) => {
    const src = book.add({
      citation: h.title,
      authority: "primary",
      source_type: "regulatory",
      source_url: h.url ?? undefined,
      effective_date: h.date ?? undefined,
      content: `${h.title} — ${h.detail}`,
    });
    refs.push(src.ref);
    return `[${src.ref}] ${h.date ? `${h.date} — ` : ""}${h.title}\n    ${h.detail}`;
  });
  return { text: `openFDA ${endpoint} (${hits.length}):\n${lines.join("\n")}`, hits: hits.length, refs };
}

async function fedRegSearchTool(input: Record<string, unknown>, book: SourceBook): Promise<ToolOutcome> {
  const term = str(input["term"]);
  if (!term) return { text: "federal_register_search needs a term.", hits: 0, refs: [] };
  const type = str(input["type"]) || undefined;
  const after = str(input["after"]) || undefined;
  let hits;
  try {
    hits = await memoTTL(toolCacheKey("fed_register", { term, type: type ?? "", after: after ?? "" }), TOOL_CACHE_TTL_MS, () =>
      fedRegSearch(term, { ...(type ? { type } : {}), ...(after ? { after } : {}) }),
    );
  } catch (err) {
    return { text: `federal_register_search failed: ${trunc(err instanceof Error ? err.message : "error", 200)}`, hits: 0, refs: [] };
  }
  if (!hits.length) return { text: `No Federal Register documents for "${term}".`, hits: 0, refs: [] };
  const refs: string[] = [];
  const lines = hits.map((h) => {
    const src = book.add({
      citation: h.title,
      authority: "primary",
      source_type: "regulatory",
      source_url: h.url,
      effective_date: h.date,
      content: `${h.type} (${h.agencies.join(", ")}) — ${h.abstract ?? h.title}`,
    });
    refs.push(src.ref);
    return `[${src.ref}] ${h.date} · ${h.type}${h.agencies.length ? ` · ${h.agencies.join(", ")}` : ""}\n    ${h.title}${h.abstract ? `\n    ${h.abstract}` : ""}`;
  });
  return { text: `Federal Register (${hits.length}):\n${lines.join("\n")}`, hits: hits.length, refs };
}

async function ecfrSearchTool(input: Record<string, unknown>, book: SourceBook): Promise<ToolOutcome> {
  const query = str(input["query"]);
  if (!query) return { text: "ecfr_search needs a query.", hits: 0, refs: [] };
  let hits;
  try {
    hits = await memoTTL(toolCacheKey("ecfr", { query }), TOOL_CACHE_TTL_MS, () => ecfrSearch(query));
  } catch (err) {
    return { text: `ecfr_search failed: ${trunc(err instanceof Error ? err.message : "error", 200)}`, hits: 0, refs: [] };
  }
  if (!hits.length) return { text: `No eCFR sections for "${query}".`, hits: 0, refs: [] };
  const refs: string[] = [];
  const lines = hits.map((h) => {
    const src = book.add({
      citation: h.hierarchy || h.heading,
      authority: "primary",
      source_type: "regulatory",
      content: `${h.hierarchy}: ${h.excerpt}`,
    });
    refs.push(src.ref);
    return `[${src.ref}] ${h.hierarchy || h.heading}\n    ${h.excerpt}`;
  });
  return { text: `eCFR (${hits.length}):\n${lines.join("\n")}`, hits: hits.length, refs };
}

async function pubmedSearchTool(input: Record<string, unknown>, book: SourceBook): Promise<ToolOutcome> {
  const query = str(input["query"]);
  if (query.length < 3) return { text: "search_pubmed needs a query of at least 3 characters.", hits: 0, refs: [] };
  const limit = clamp(input["limit"], 5, 20);
  let hits;
  try {
    hits = await memoTTL(toolCacheKey("pubmed", { query, limit }), TOOL_CACHE_TTL_MS, () => pubmedSearch(query, limit));
  } catch (err) {
    return { text: `search_pubmed failed: ${trunc(err instanceof Error ? err.message : "error", 200)}`, hits: 0, refs: [] };
  }
  if (!hits.length) return { text: `No PubMed articles for "${query}".`, hits: 0, refs: [] };
  const refs: string[] = [];
  const lines = hits.map((h) => {
    const cite = `${h.title}${h.journal ? ` — ${h.journal}` : ""}${h.year ? ` (${h.year})` : ""}`;
    const src = book.add({
      citation: cite,
      authority: "primary",
      source_type: "science",
      source_url: h.url,
      effective_date: h.year || undefined,
      content: trunc(`${h.authors ? `${h.authors}. ` : ""}${cite}. ${h.abstract || "(no abstract available)"}`, 1500),
    });
    refs.push(src.ref);
    return `[${src.ref}] PMID ${h.pmid} — ${cite}${h.authors ? `\n    ${h.authors}` : ""}\n    ${trunc(h.abstract || "(no abstract)", 500)}`;
  });
  return { text: `PubMed (${hits.length}):\n${lines.join("\n\n")}`, hits: hits.length, refs };
}

async function secSearchTool(input: Record<string, unknown>, book: SourceBook): Promise<ToolOutcome> {
  const query = str(input["query"]);
  if (query.length < 3) return { text: "sec_search needs a query of at least 3 characters.", hits: 0, refs: [] };
  const forms = str(input["forms"]) || undefined;
  const after = str(input["after"]) || undefined;
  let hits;
  try {
    hits = await memoTTL(
      toolCacheKey("sec_search", { query, forms: forms ?? "", after: after ?? "" }),
      TOOL_CACHE_TTL_MS,
      () => secSearch(query, { ...(forms ? { forms } : {}), ...(after ? { after } : {}) }),
    );
  } catch (err) {
    return { text: `sec_search failed: ${trunc(err instanceof Error ? err.message : "error", 200)}`, hits: 0, refs: [] };
  }
  if (!hits.length) return { text: `No SEC EDGAR filings for "${query}".`, hits: 0, refs: [] };
  const refs: string[] = [];
  const lines = hits.map((h) => {
    const src = book.add({
      citation: `${h.company || "SEC filer"} — ${h.form || "filing"}`,
      authority: "primary",
      source_type: "sec",
      source_url: h.url || undefined,
      effective_date: h.date || undefined,
      content: `${h.form || "Filing"}${h.date ? ` filed ${h.date}` : ""}${h.company ? ` by ${h.company}` : ""}`,
    });
    refs.push(src.ref);
    return `[${src.ref}] ${h.date ? `${h.date} · ` : ""}${h.form || "filing"} — ${h.company || "SEC filer"}`;
  });
  return { text: `SEC EDGAR (${hits.length}):\n${lines.join("\n")}`, hits: hits.length, refs };
}

async function clinicalTrialsSearchTool(input: Record<string, unknown>, book: SourceBook): Promise<ToolOutcome> {
  const query = str(input["query"]);
  if (query.length < 3) return { text: "clinicaltrials_search needs a query of at least 3 characters.", hits: 0, refs: [] };
  const limit = clamp(input["limit"], 5, 20);
  let hits;
  try {
    hits = await memoTTL(toolCacheKey("clinicaltrials", { query, limit }), TOOL_CACHE_TTL_MS, () =>
      clinicalTrialsSearch(query, limit),
    );
  } catch (err) {
    return { text: `clinicaltrials_search failed: ${trunc(err instanceof Error ? err.message : "error", 200)}`, hits: 0, refs: [] };
  }
  if (!hits.length) return { text: `No ClinicalTrials.gov studies for "${query}".`, hits: 0, refs: [] };
  const refs: string[] = [];
  const lines = hits.map((h) => {
    const detail = [h.status, h.phase, h.conditions ? `conditions: ${h.conditions}` : "", h.sponsor ? `sponsor: ${h.sponsor}` : ""]
      .filter(Boolean)
      .join(" · ");
    const src = book.add({
      citation: `${h.title}${h.nctId ? ` (${h.nctId})` : ""}`,
      authority: "primary",
      source_type: "science",
      source_url: h.url || undefined,
      effective_date: h.date || undefined,
      content: `${h.title} — ${detail}`,
    });
    refs.push(src.ref);
    return `[${src.ref}] ${h.nctId} — ${h.title}\n    ${detail}`;
  });
  return { text: `ClinicalTrials.gov (${hits.length}):\n${lines.join("\n\n")}`, hits: hits.length, refs };
}

const MIME_BY_EXT: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  svg: "image/svg+xml",
  csv: "text/csv",
  json: "application/json",
  txt: "text/plain",
  md: "text/markdown",
  html: "text/html",
  pdf: "application/pdf",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  xls: "application/vnd.ms-excel",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  doc: "application/msword",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  zip: "application/zip",
};
function mimeForName(name: string): string {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  return MIME_BY_EXT[ext] ?? "application/octet-stream";
}

let artifactSeq = 0;

async function runPythonTool(input: Record<string, unknown>): Promise<ToolOutcome> {
  const code = str(input["code"]);
  if (code.trim().length < 2) return { text: "run_python needs a code string.", hits: 0, refs: [] };
  let res;
  try {
    res = await runPython(code);
  } catch (err) {
    return { text: `run_python failed: ${trunc(err instanceof Error ? err.message : "error", 200)}`, hits: 0, refs: [] };
  }
  const out = res.text.trim();
  if (res.isError) return { text: `Python error:\n${trunc(out || "(no output)", 3000)}`, hits: 0, refs: [] };

  // Charts (matplotlib plt.show) stream back inline as base64 PNGs; files the
  // code wrote to disk (savefig / to_excel / docx / pdf) are fetched separately.
  const artifacts: Artifact[] = [];
  for (const data of res.images) {
    artifacts.push({ id: `img-${++artifactSeq}`, kind: "image", name: `chart-${artifactSeq}.png`, mime: "image/png", dataB64: data });
  }
  let files: Awaited<ReturnType<typeof collectNewArtifacts>> = [];
  try {
    files = await collectNewArtifacts();
  } catch {
    /* best effort — never fail the tool over artifact collection */
  }
  for (const f of files) {
    artifacts.push({
      id: `file-${++artifactSeq}-${f.name}`,
      kind: "file",
      name: f.name,
      mime: mimeForName(f.name),
      dataB64: f.dataB64 ?? undefined,
      size: f.size,
    });
  }

  const chartN = res.images.length;
  const fileNames = files.map((f) => f.name);
  const note =
    (chartN ? `\n[${chartN} chart(s) generated]` : "") +
    (fileNames.length ? `\n[files created: ${fileNames.join(", ")}]` : "");
  return {
    text: out ? `Output:\n${trunc(out, 4000)}${note}` : `(ran with no printed output)${note}`,
    hits: 0,
    refs: [],
    artifacts: artifacts.length ? artifacts : undefined,
  };
}

async function readDocumentTool(input: Record<string, unknown>, attachments?: Attachment[]): Promise<ToolOutcome> {
  const name = str(input["name"]);
  const query = str(input["query"]);
  if (!name) return { text: "read_document needs a file name.", hits: 0, refs: [] };
  try {
    // Resolve the uploaded file: BDA docs have their full markdown in S3;
    // sandbox docs have a sidecar the code interpreter greps.
    const att = (attachments ?? []).find((a) => a.name === name);
    let text: string;
    if (att?.markdownKey) {
      text = await searchMarkdownKey(att.markdownKey, query);
      if (!text) text = `No passages in "${name}" matched "${query}".`;
    } else {
      text = await readDocument(name, query);
    }
    return { text: trunc(text, 6000), hits: 0, refs: [] };
  } catch (err) {
    return { text: `read_document failed: ${trunc(err instanceof Error ? err.message : "error", 200)}`, hits: 0, refs: [] };
  }
}

async function createDocumentTool(input: Record<string, unknown>): Promise<ToolOutcome> {
  const format = str(input["format"]) || "pdf";
  const title = str(input["title"]) || "Document";
  const content = str(input["content"]);
  const style = str(input["style"]) || "legal";
  const filename = str(input["filename"]) || undefined;
  if (content.trim().length < 2) return { text: "create_document needs markdown content.", hits: 0, refs: [] };
  const res = await generateDocument(format, title, content, filename, style);
  if ("error" in res) return { text: `create_document failed: ${trunc(res.error, 200)}`, hits: 0, refs: [] };
  const artifact: Artifact = {
    id: `doc-${++artifactSeq}-${res.name}`,
    kind: "file",
    name: res.name,
    mime: res.mime,
    dataB64: res.dataB64,
    size: res.size,
  };
  const kb = Math.max(1, Math.round(res.size / 1024));
  return { text: `Created ${res.name} (${kb} KB). The attorney can download it below.`, hits: 0, refs: [], artifacts: [artifact] };
}

/** One executor for every tool the single agent can call. */
export async function executeResearchTool(
  name: string,
  input: Record<string, unknown>,
  book: SourceBook,
  attachments?: Attachment[],
): Promise<ToolOutcome> {
  if (name === "fetch_page") return fetchPageTool(input, book);
  if (name === "verify_citations") return verifyCitationsTool(input, book);
  if (name === "fda_search") return fdaSearchTool(input, book);
  if (name === "federal_register_search") return fedRegSearchTool(input, book);
  if (name === "ecfr_search") return ecfrSearchTool(input, book);
  if (name === "search_pubmed") return pubmedSearchTool(input, book);
  if (name === "sec_search") return secSearchTool(input, book);
  if (name === "clinicaltrials_search") return clinicalTrialsSearchTool(input, book);
  if (name === "run_python") return runPythonTool(input);
  if (name === "read_document") return readDocumentTool(input, attachments);
  if (name === "create_document") return createDocumentTool(input);
  // web_search (category-scoped domain sets) and every db_* tool.
  return executeTool(name, input, book);
}

export const clampLimit = clamp;
