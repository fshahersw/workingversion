# Fix the zero-hit corpus searches

The research agents are effectively doing web research: in the last run, 39 of 43 sources came from Tavily and only 4 from the 308k-document registry. Every `search_filings` call returned 0 hits.

## What the reads confirmed

- The Zantac matter **is** in the registry (`IN RE: ZANTAC (RANITIDINE) PRODUCTS LIABILITY LITIGATION`).
- `registry.docket_entries` has **0** rows whose description contains "zantac", but **403** rows containing "bellwether". Docket entry text describes the filing, not the case name — so searching entry text for a case name can never match.
- Both search paths use a single contiguous substring match (`description ilike *needle*`, and `case_name/docket_number/matter_key ilike *needle*`). A multi-word query like "Zantac bellwether trial selection order" only matches if that exact phrase appears verbatim. That is why single words ("Zantac", "ranitidine", "2924") hit and every phrase returned 0.
- There is **no** trigram or full-text index on `docket_entries.description` or `matters.case_name` — only pkey/matter/date indexes. Any broader matching needs an index or it will crawl 209k rows.

Two separate bugs: the matching is phrase-literal, and filings search has no way to scope to a matter, so agents search the whole corpus by case name and get nothing.

## The fix

**1. Token-based matching instead of phrase matching**

Split the query into words, drop stopwords and noise tokens ("in re", "litigation", "products", "liability", "order", "the"), and require all remaining tokens (AND) rather than the whole phrase. Applies to both matter search and filings search.

**2. Scope filings search to a matter**

Add an optional `matter_id` (and `case` name) input to `search_filings`, and plumb it into the registry query. This is the path that actually works: find the matter, then search its docket entries for the procedural term ("bellwether", "Daubert", "case management order").

**3. Index the corpus for it**

Add `pg_trgm` GIN indexes on `registry.docket_entries.description` and `registry.matters.case_name` in the external corpus database so token matching stays fast across 209k entries. Ship as a migration file alongside the existing `supabase/corpus/*.sql`.

**4. Teach the agents the right search order**

Update the sub-agent prompt and the `search_filings` tool description: always resolve the matter first with `search_matters` (short, distinctive terms — drug name, docket number), then search filings **scoped to that matter_id** using procedural vocabulary, never the case name. Also raise the sub-agent step budget slightly so a resolve-then-search chain fits.

**5. Verify**

Re-run the Zantac query end to end and confirm registry sources materially outnumber the current 4, with `search_filings` returning non-zero hits in the agent logs.

## Technical detail

- `src/lib/corpus.server.ts`: `loadMatterPage` and `loadFilingSearch` gain token-AND matching (PostgREST `and=(description.ilike.*a*,description.ilike.*b*)`), and `loadFilingSearch` gains a `matterId` filter. Existing UI callers keep working — single-token queries behave identically.
- `src/lib/agents/tools.server.ts`: `SEARCH_FILINGS` schema gains `matter_id`; descriptions rewritten to state the resolve-then-scope workflow.
- `src/lib/agents/prompts.ts`: sub-agent search strategy section rewritten.
- `src/lib/agents/orchestrator.server.ts`: sub-agent `maxSteps` 6 → 8.
- New `supabase/corpus/registry-search-indexes.sql`, applied to the corpus database.

Not touched: the Anthropic client, models, effort settings, SSE contract, or any UI.
