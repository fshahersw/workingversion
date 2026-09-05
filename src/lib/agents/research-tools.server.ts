// ============================================================================
// Unified tool set for the single research agent (server-only).
//
// Reuses the existing, battle-tested search + DocketBird tools (executeTool in
// tools.server) and ADDS the new capabilities: fetch_page (read a primary
// source in full) and CourtListener RECAP (search / list entries / read a
// filing's free text). One flat tool list, one executor, one shared SourceBook
// so [S#] refs stay stable across the whole run.
// ============================================================================
import type { ToolDef } from "./anthropic.server";
import { AGENT_TOOLS, SourceBook, executeTool, type ToolOutcome } from "./tools.server";
import { fetchPage } from "./fetch-page.server";
import { memoTTL, toolCacheKey, TOOL_CACHE_TTL_MS } from "./run-state.server";
import {
  recapSearch,
  getDocketEntries,
  readRecapDocument,
  courtlistenerConfigured,
} from "./courtlistener.server";

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
    "Fetch a URL and read its main text + outbound links as clean text. Use to READ a primary source in full — a court opinion page, an agency rule, a news article, a docket page — after a search surfaces it. Reading the actual page beats reasoning from a search snippet. For a court FILING's text, prefer recap_read or db_read_filing.",
  input_schema: {
    type: "object",
    properties: { url: { type: "string", description: "Absolute http(s) URL to fetch and read." } },
    required: ["url"],
  },
};

const RECAP_SEARCH_TOOL: ToolDef = {
  name: "recap_search",
  description:
    "Search CourtListener's FREE RECAP archive of PACER dockets and filings (broad federal coverage). Use to find a docket or filing — especially when DocketBird returns access-limited, or to corroborate. Returns matching dockets with their docket_id and nested document ids you can then read with recap_read.",
  input_schema: {
    type: "object",
    properties: {
      query: { type: "string", description: "Distinctive terms — party, doctrine, or a case caption." },
      court: { type: "string", description: "Optional court id filter, e.g. 'scd', 'njd', 'nysd'." },
      docket_number: { type: "string", description: "Optional docket number filter, e.g. '2:18-mn-2873'." },
      filed_after: { type: "string", description: "YYYY-MM-DD, inclusive." },
      filed_before: { type: "string", description: "YYYY-MM-DD, inclusive." },
    },
    required: ["query"],
  },
};

const RECAP_DOCKET_TOOL: ToolDef = {
  name: "recap_docket",
  description:
    "List the docket ENTRIES for a RECAP docket_id (from recap_search), newest identifiers first, with each entry's documents (id, number, page count, availability). Use to locate the specific filing to read with recap_read.",
  input_schema: {
    type: "object",
    properties: { docket_id: { type: "string", description: "RECAP docket_id from recap_search." } },
    required: ["docket_id"],
  },
};

const RECAP_READ_TOOL: ToolDef = {
  name: "recap_read",
  description:
    "Read the full extracted TEXT of a RECAP document by its document id (from recap_search or recap_docket). FREE for archived filings — this is how you actually PULL a filing's text when DocketBird cannot. Returns the plain text plus a PDF link.",
  input_schema: {
    type: "object",
    properties: { document_id: { type: "string", description: "RECAP recap-document id." } },
    required: ["document_id"],
  },
};

/** The full flat tool list the single agent sees. */
export const RESEARCH_TOOLS: ToolDef[] = [
  ...AGENT_TOOLS.legal_research, // search_authorities + 7 category web-search tools
  FETCH_PAGE_TOOL,
  RECAP_SEARCH_TOOL,
  RECAP_DOCKET_TOOL,
  RECAP_READ_TOOL,
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

async function recapSearchTool(input: Record<string, unknown>, book: SourceBook): Promise<ToolOutcome> {
  if (!courtlistenerConfigured()) return { text: "RECAP is not configured (COURTLISTENER_API_TOKEN missing).", hits: 0, refs: [] };
  const query = str(input["query"]);
  if (query.length < 3) return { text: "Query must be at least 3 characters.", hits: 0, refs: [] };
  const searchArgs = {
    court: str(input["court"]) || undefined,
    docketNumber: str(input["docket_number"]) || undefined,
    filedAfter: str(input["filed_after"]) || undefined,
    filedBefore: str(input["filed_before"]) || undefined,
  };
  let hits;
  try {
    hits = await memoTTL(
      toolCacheKey("recap_search", { query, ...searchArgs }),
      TOOL_CACHE_TTL_MS,
      () => recapSearch(query, { type: "r", ...searchArgs, orderBy: "dateFiled desc" }),
    );
  } catch (err) {
    return { text: `recap_search failed: ${trunc(err instanceof Error ? err.message : "error", 200)}`, hits: 0, refs: [] };
  }
  if (!hits.length) return { text: `No RECAP dockets for "${query}".`, hits: 0, refs: [] };

  const refs: string[] = [];
  const lines = hits.slice(0, 8).map((h) => {
    const src = book.add({
      citation: `${h.caseName}${h.docketNumber ? ` (${h.docketNumber})` : ""}${h.court ? ` — ${h.court}` : ""}`,
      authority: "registry",
      source_type: "docket",
      source_url: h.absoluteUrl ?? undefined,
      effective_date: h.dateFiled ?? undefined,
      content: `RECAP docket ${h.docketNumber ?? ""} (${h.court ?? ""})`,
    });
    refs.push(src.ref);
    const docs = h.documents
      .slice(0, 3)
      .map((d) => `    doc id=${d.id} #${d.documentNumber ?? "?"} ${trunc(d.description || d.snippet, 90)}`)
      .join("\n");
    return `[${src.ref}] docket_id=${h.docketId} — ${h.caseName} (${h.docketNumber ?? "?"}, ${h.court ?? "?"})${h.moreDocs ? " [more docs available]" : ""}${docs ? `\n${docs}` : ""}`;
  });
  return {
    text: `${lines.join("\n\n")}\n\nNEXT: recap_docket <docket_id> to list all entries, or recap_read <doc id> to read a filing's text.`,
    hits: hits.length,
    refs,
  };
}

async function recapDocketTool(input: Record<string, unknown>): Promise<ToolOutcome> {
  if (!courtlistenerConfigured()) return { text: "RECAP is not configured.", hits: 0, refs: [] };
  const docketId = str(input["docket_id"]);
  if (!docketId) return { text: "docket_id is required (from recap_search).", hits: 0, refs: [] };
  let entries;
  try {
    entries = await memoTTL(toolCacheKey("recap_docket", { docketId }), TOOL_CACHE_TTL_MS, () => getDocketEntries(docketId, { pageSize: 100 }));
  } catch (err) {
    return { text: `recap_docket failed: ${trunc(err instanceof Error ? err.message : "error", 200)}`, hits: 0, refs: [] };
  }
  if (!entries.length) return { text: `No docket entries for RECAP docket ${docketId}.`, hits: 0, refs: [] };
  const lines = entries.slice(0, 60).map((e) => {
    const docs = e.documents
      .map((d) => `    doc id=${d.id} #${d.documentNumber ?? "?"}${d.attachmentNumber != null ? `.${d.attachmentNumber}` : ""} (${d.pageCount ?? "?"}pp, ${d.isAvailable ? "available" : "not archived"})`)
      .join("\n");
    return `#${e.entryNumber ?? "?"} ${e.dateFiled ?? ""} — ${trunc(e.description, 120)}${docs ? `\n${docs}` : ""}`;
  });
  return {
    text: `RECAP docket ${docketId} — ${entries.length} entries:\n${lines.join("\n")}\n\nRead a filing with recap_read <doc id>.`,
    hits: entries.length,
    refs: [],
  };
}

async function recapReadTool(input: Record<string, unknown>, book: SourceBook): Promise<ToolOutcome> {
  if (!courtlistenerConfigured()) return { text: "RECAP is not configured.", hits: 0, refs: [] };
  const documentId = str(input["document_id"]);
  if (!documentId) return { text: "document_id is required (from recap_search or recap_docket).", hits: 0, refs: [] };
  let doc;
  try {
    doc = await memoTTL(toolCacheKey("recap_read", { documentId }), TOOL_CACHE_TTL_MS, () => readRecapDocument(documentId));
  } catch (err) {
    return { text: `recap_read failed: ${trunc(err instanceof Error ? err.message : "error", 200)}`, hits: 0, refs: [] };
  }
  if (!doc.plainText.trim()) {
    return {
      text: `RECAP document ${documentId} has no extracted text${doc.pdfUrl ? ` (scanned filing; PDF: ${doc.pdfUrl})` : " and no archived PDF"}. ${doc.isAvailable ? "" : "It is not in the free archive."}`,
      hits: 0,
      refs: [],
    };
  }
  const src = book.add({
    citation: doc.description || `RECAP filing #${doc.documentNumber ?? documentId}`,
    authority: "registry",
    source_type: "filing",
    source_url: doc.pdfUrl ?? undefined,
    content: trunc(doc.plainText, 3000),
  });
  return {
    text: `[${src.ref}] ${doc.description || `filing #${doc.documentNumber ?? ""}`} (${doc.pageCount ?? "?"}pp${doc.ocrStatus ? `, ocr=${doc.ocrStatus}` : ""})\n${trunc(doc.plainText, 3500)}`,
    hits: 1,
    refs: [src.ref],
  };
}

/** One executor for every tool the single agent can call. */
export async function executeResearchTool(
  name: string,
  input: Record<string, unknown>,
  book: SourceBook,
): Promise<ToolOutcome> {
  if (name === "fetch_page") return fetchPageTool(input, book);
  if (name === "recap_search") return recapSearchTool(input, book);
  if (name === "recap_docket") return recapDocketTool(input);
  if (name === "recap_read") return recapReadTool(input, book);
  // search_authorities, the category web tools, and every db_* tool.
  return executeTool(name, input, book);
}

export const clampLimit = clamp;
