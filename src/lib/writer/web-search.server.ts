// ============================================================================
// Writer web search (server-only). The Writer's `web_search` tool asks for
// `{query, maxResults}` and expects `{results:[{title,url,snippet}], answer?,
// method}`. This bridges that to the platform's curated, category-scoped
// web_search (tools.server) with categories picked from the query. Each call
// uses a fresh SourceBook: Writer findings never enter the Research agent's
// memory or source numbering.
// ============================================================================
import { asksForRecentSources } from "@/lib/agents/search-window";
import { SourceBook, executeTool } from "@/lib/agents/tools.server";
import { localSyntheticEnabled } from "@/lib/local-development";

export type WriterSearchResult = {
  results: Array<{ title: string; url: string; snippet: string }>;
  answer?: string;
  method: string;
  error?: string;
};

/** Pick 1-4 curated categories from the query; general web + legal news by default. */
function categoriesFor(query: string): string[] {
  const q = query.toLowerCase();
  const picks = new Set<string>();
  if (
    /\bv\.\s|\bvs\.?\s|\bcourt\b|\bholding\b|\bopinion\b|\bcircuit\b|\bappeal|\bruling\b|\bjudge\b|\bmotion\b/.test(
      q,
    )
  ) {
    picks.add("federal_case_law");
    picks.add("state_case_law");
  }
  if (/\bmdl\b|\bclass action\b|\bsettlement\b|\bjpml\b|\bbellwether\b/.test(q))
    picks.add("mdl_class_action");
  if (/§|\bu\.s\.c\b|\busc\b|\bstatute|\bcode\b|\bact\b|\bbill\b|\blegislat/.test(q))
    picks.add("statutes_legislation");
  if (/\bcfr\b|\bfederal register\b|\bregulation|\brulemaking\b|\bfinal rule\b/.test(q))
    picks.add("federal_regulations");
  if (/\bfda\b|\brecall\b|\bwarning letter\b|\blabel(ing)?\b|\bdevice\b|\bdrug\b|\bpharma/.test(q))
    picks.add("fda_drug_device");
  if (
    /\bstudy\b|\bstudies\b|\btrial\b|\befficacy\b|\bepidemiolog|\bpubmed\b|\bmeta-analysis\b|\bcausation\b/.test(
      q,
    )
  )
    picks.add("scientific_medical");
  if (/\bsec\b|\b10-k\b|\b8-k\b|\bsecurities\b|\bshareholder/.test(q)) picks.add("sec_securities");
  if (
    /\bftc\b|\bcpsc\b|\bnhtsa\b|\bepa\b|\bosha\b|\bdoj\b|\bconsent decree\b|\benforcement\b/.test(q)
  )
    picks.add("agency_enforcement");
  const list = [...picks].slice(0, 3);
  if (list.length < 4) list.push("legal_news");
  if (list.length < 4) list.push("general_web");
  return list.slice(0, 4);
}

export async function writerWebSearch(query: string, maxResults = 6): Promise<WriterSearchResult> {
  const q = query.trim();
  if (q.length < 3 || q.length > 400)
    return { results: [], method: "error", error: "Query must contain 3–400 characters." };
  if (localSyntheticEnabled()) {
    const { localPublicSearch } = await import("./local-public-search.server");
    return localPublicSearch(q, maxResults);
  }
  const book = new SourceBook();
  const limit = Math.min(10, Math.max(1, Math.floor(maxResults) || 6));
  const input: Record<string, unknown> = {
    query: q,
    categories: categoriesFor(q),
    limit,
  };
  // The platform default is the last 30 days. Drafting usually needs authority
  // regardless of age, so widen the window unless the query asks for recency.

  try {
    const out = await executeTool("web_search", input, book, {
      unrestrictedDates: !asksForRecentSources(q),
    });
    const results = book.all().flatMap((s) => {
      const url = s.source_url ?? "";
      if (!/^https?:\/\//i.test(url)) return [];
      return [
        {
          title: (s.citation || s.authority || "Source").slice(0, 300),
          url,
          snippet: (s.content || "").replace(/\s+/g, " ").trim().slice(0, 700),
        },
      ];
    });
    if (!results.length && /not configured|\bfailed\b|unavailable|timed out|unauthorized|access denied/i.test(out.text)) {
      return { results: [], method: "error", error: "Public search could not complete. This is a service failure, not a finding of zero matching sources." };
    }
    return { results: results.slice(0, limit * 2), method: "platform" };
  } catch (err) {
    return {
      results: [],
      method: "error",
      error: err instanceof Error ? err.message : "Web search failed.",
    };
  }
}
