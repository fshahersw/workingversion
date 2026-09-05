# Retire the legacy corpus: drop the old tables and buckets safely

## What is actually still there

I inspected the corpus database and its storage directly.

Legacy database objects — schema `registry`, **44 tables/views** (matters, documents, docket_entries, records, provenance, releases, the `enrich_*` sidecars, all `cl_staging_*` / `local_staging_*` / `*_staging` tables, `citations`, `opinions`, health views).

Legacy storage buckets:

| Bucket | Objects | Role |
|---|---:|---|
| `kb-staging` | 686,785 | old scrape/staging dump |
| `FORAWS` | 18,261 | registry-era PDF store |
| `matters` | 6,550 | **current** corpus v2 store — keep |

New corpus (`corpus` schema + `public.corpus_*` views) is self-sufficient for what is live today: Apple 391 docs / 334 PDFs, Insulin 3,019 docs / 2,037 PDFs, Roundup shell with 0 docs. Every stored document row points at the `matters` bucket (2,371 of 2,371) — nothing live reads `FORAWS` or `kb-staging` for file bytes.

## The one real blocker

Four agent tools still read the old schema. `src/lib/agents/tools.server.ts` calls `loadMatterPage`, `loadMatterDetail`, `loadFilingSearch`, `loadDocuments` from `src/lib/corpus.server.ts`, which is pinned to `SCHEMA = "registry"` and layers the `enrich_*` sidecar on top via `src/lib/enrich.server.ts` and `src/lib/sidecar.server.ts`. Dropping `registry` before rewiring these would break `search_matters`, `get_matter`, `search_filings`, and `list_documents` mid-answer. The RAG tools (`search_document_text`, `read_document`) and the whole Matters workspace already run on `corpus.*` and are unaffected.

Also in flight: embeddings are at 16,139 of 26,986 chunks. Nothing in this plan touches `doc_chunks`, but the bucket purge is heavy I/O against the same project, so it runs after the embedding job finishes.

## The sequence

**Step 1 — Repoint the agent tools (code only, nothing deleted).**
Rewrite the four corpus tools in `tools.server.ts` to use the v2 readers in `src/lib/workspace.server.ts` (`corpus_matters`, `corpus_docket_entries`, `corpus_documents`), using `display_label_pretty` / `sort_seq` so agent citations match the workspace labels. Then delete `corpus.server.ts`, `enrich.server.ts`, `sidecar.server.ts`, and the now-unused pieces of `corpus-types.ts` / `matters-data.ts`. After this, a repo-wide search for `registry` returns no data-access code. Verify with a typecheck plus a live research query that exercises each tool.

**Step 2 — Take a safety snapshot before any drop.**
`pg_dump` the `registry` schema (schema + data) to a compressed file kept outside the app, and write a manifest listing every object in `kb-staging` and `FORAWS` (key, size, hash) so any future re-fetch is possible without the buckets themselves. Row counts are recorded per table first.

**Step 3 — Soft-retire the schema, don't drop it yet.**
`ALTER SCHEMA registry RENAME TO registry_retired` and revoke API access. This is instant, fully reversible, and any missed reference fails loudly in one place. Run the app: Home, Matters (both matters, filter chips, PDF viewer), and a full research run with corpus and web results.

**Step 4 — Drop the schema.** After the soak in Step 3 looks clean, `DROP SCHEMA registry_retired CASCADE`.

**Step 5 — Empty and delete the old buckets.** Delete `FORAWS` (18k objects) first, confirm the app is unaffected, then `kb-staging` (687k objects, deleted in batched pages). Both are removed only after the dumps in Step 2 exist. The `matters` bucket and the managed project's `avatars` bucket are untouched.

## Consequences to accept before we start

- `FORAWS` and `kb-staging` stop being migration sources. Roundup and every future matter must be ingested from the local file sets you supply — which is already the agreed workflow.
- The old registry's 4,159 matter skeletons disappear from agent search; agents will only see matters that exist in corpus v2 (currently 3). If you want the broader matter list to stay searchable, say so and I will port those skeleton rows into `corpus.matters` as unpopulated shells in Step 1 instead of losing them.
- Deletion of ~705k storage objects is not reversible from Lovable's side once run.

## Technical notes

- All database work runs against the corpus Postgres over `CORPUS_DB_URL`; scripts land in `supabase/corpus/` (rename + drop) and `scripts/pipeline/` (bucket purge), each idempotent and re-runnable.
- Bucket deletion uses the corpus service key through the storage API in pages of 1,000 keys with progress logging, so an interruption resumes cleanly.
- No changes to the Lovable Cloud managed project, auth, or the `avatars` bucket.
