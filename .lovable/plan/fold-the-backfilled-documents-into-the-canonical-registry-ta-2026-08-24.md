# Fold the backfilled documents into the canonical registry tables

## What I found

I checked the corpus database directly. Nothing was written to a `public` table — there are no `public.enrich_*` tables at all. But your instinct is right about the substance: the backfill landed in **side tables** instead of the corpus's own document tables.

Current state in the `registry` schema:

| Table | Rows | Matters covered |
| --- | --- | --- |
| `registry.matters` | 4,159 | — |
| `registry.documents` (canonical) | 13,971 | 16 |
| `registry.docket_entries` (canonical) | 29,340 | — |
| `registry.enrich_documents` (backfill sidecar) | 308,332 | 1,040 |
| `registry.enrich_entries` (backfill sidecar) | 204,924 | — |

Every one of the 13,971 canonical documents also exists in the sidecar (matched on `doc_uid`), so the sidecar is a strict superset. That is why documents look "missing": the app's main document reads go to `registry.documents`, which only covers 16 matters, while the 283,317 storage-linked PDFs sit in the sidecar and only surface on the few screens wired to it.

## Why the backfill went to a sidecar

`registry.documents` has strict load-time constraints: `record_id` (a required row in `registry.records` tied to a release), `sha256` NOT NULL with a 64-hex check, and `byte_count`, `s3_bucket`, `s3_key` all NOT NULL. The storage catalog only supplies `sha1` for ~23k of the 308k rows, so those rows cannot be inserted as-is.

## The plan

1. **Create a catalog release + records lineage.** Add a `releases` row (e.g. `catalog-backfill-<date>`) and generate one `registry.records` row per promoted document and docket entry, with `dataset_name` of `documents` / `docket_entries` and a deterministic `identity_sha256` derived from `doc_uid`. This keeps the promoted rows inside the registry's existing provenance model rather than bypassing it.
2. **Relax the two constraints that block catalog-sourced rows.** Make `sha256` nullable (keeping the hex check when present) and `byte_count` nullable, or default it from the catalog's `file_size`. Rows with a real `sha1` keep it in a new `sha1` column so nothing is lost.
3. **Promote docket entries first, then documents.** Insert missing `registry.docket_entries` from `enrich_entries` (keyed on `matter_id` + `entry_number`, matching the existing unique index), then insert missing `registry.documents` from `enrich_documents`, linking `docket_entry_id` by the same key. Existing rows are updated in place, not duplicated — the join key is `doc_uid`, which already matches 100% for current rows.
4. **Carry the catalog-only fields.** Add the columns the registry lacks but the UI already shows (`page_count`, `entry_date_filed`, `document_number`, `attachment_number`, `is_sealed`, `courtlistener_url`, `pacer_doc_id`) to `registry.documents` so the enrichment overlay is no longer needed for display.
5. **Point the app at the canonical tables.** Remove the sidecar reads in `src/lib/sidecar.server.ts` and the enrichment overlay path in `src/lib/enrich.server.ts`, so `MatterDetail`, `ReviewGrid`, and the corpus counters all read `registry.documents` / `registry.docket_entries` like the rest of the corpus.
6. **Keep the sidecar as a staging table, then retire it.** After verification (per-matter counts before/after, spot checks on PDF links), the `enrich_*` tables become the loader's landing zone only, and `registry.enrich_coverage` is rebuilt against the canonical tables.

## Verification before/after

- Total documents per matter for the 1,040 backfilled matters must match the sidecar counts exactly.
- The 13,971 pre-existing canonical documents must keep their `document_id`, `record_id`, and `sha256` untouched.
- 283,317 rows must end up with a resolvable `s3_bucket`/`s3_key` pair.

## Technical notes

- All work runs against the external corpus Postgres via the existing `CORPUS_DB_URL` superuser connection, in a single transactional script under `supabase/corpus/`, re-runnable and idempotent.
- No changes to the Lovable Cloud project, and no `public`-schema tables are created.
- Promotion runs in batches so the transaction stays manageable at ~300k rows.
