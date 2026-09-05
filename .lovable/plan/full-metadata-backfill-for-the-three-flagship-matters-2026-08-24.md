# Full metadata backfill for the three flagship matters

Goal: make Insulin Pricing (2:23-md-03080), Apple Smartphone Antitrust (2:24-md-03113), and Roundup (3:16-md-02741) fully described in the registry, so agent search actually finds them and every document row carries complete, verified metadata.

## Where things stand today

| Matter | Entries | Entries with text | Docs | Docs with text | sha256 | Page counts | CourtListener/PACER IDs |
|---|---|---|---|---|---|---|---|
| Insulin 2:23-md-03080 | 659 | 0 | 1,235 | 545 | 0 | 0 | 0 |
| Apple 2:24-md-03113 | 156 | 1 | 227 | 45 | 0 | 0 | 0 |
| Roundup 3:16-md-02741 | 18,781 | 0 | 31,304 | 11,676 | 0 | 0 | 0 |

Every document row already has an S3 key and a linked docket entry, and the PDFs were verified reachable in the prior audit. What is missing is the *text and identity* metadata.

## What gets backfilled

Structured docket metadata from CourtListener RECAP (authoritative), plus per-file facts derived from the PDFs we already store. No full document text and no embeddings in this pass.

Per docket entry: description, date filed, corrected entry number.
Per document: description, document/attachment number, page count, sha256, byte count, sealed/available flags, `pacer_doc_id`, `courtlistener_url`, `download_url`.

## How it runs

1. **Prerequisite** — a CourtListener API token stored as a project secret (`COURTLISTENER_API_TOKEN`). I'll request it via the secret prompt; the run can't start without it.
2. **Pull docket data** — for each matter, page through the RECAP docket-entries and recap-documents endpoints, honoring rate limits with backoff, into a staging table `registry.cl_staging_entries` / `registry.cl_staging_documents`. Staging first means a bad pull never corrupts the canonical tables.
3. **Match** — join staged rows to existing `registry.docket_entries` / `registry.documents` on (matter, entry number, attachment number), falling back to `pacer_doc_id`. Report unmatched rows both directions rather than silently inserting.
4. **Derive from PDFs** — stream each stored PDF from S3, compute sha256 and byte count, read the page count from the PDF structure, and where CourtListener gave no description, take the first-page caption line as a fallback description.
5. **Promote** — a single transactional UPDATE per matter writes staged values into `registry.docket_entries` and `registry.documents`, only filling NULL/empty fields unless CourtListener contradicts an existing value. Nothing is deleted.
6. **Refresh search** — reindex the trigram GIN indexes and re-run the registry search sanity queries used by the agents.
7. **Verify** — re-run the coverage query and emit a before/after CSV to `/mnt/documents/three-matters-backfill-report.csv`, plus a per-matter list of anything still unmatched.

Roundup runs last and in chunks (31k docs), with resumable checkpointing in `registry.enrich_load_runs` so an interrupted run picks up where it stopped.

## Technical notes

- Backfill runs as standalone scripts under `scripts/backfill/` executed against `CORPUS_DB_URL` — not as app server functions; this is a one-off data operation, not runtime behavior.
- PDF page count and hashing use a streaming read against the S3/Supabase storage endpoint with the existing signing helper in `src/lib/s3.server.ts`; concurrency capped (~8) to stay polite to both S3 and CourtListener.
- Idempotent by design: re-running recomputes staging and re-promotes without duplicating rows.
- Schema change is additive only: two staging tables plus a `registry.documents.text_source` column recording where each description came from (`courtlistener`, `pdf`, `original`).
- No app UI changes in this pass; the Matters tab picks the richer data up automatically.

## Out of scope

Full document text extraction, chunking, and embeddings — deferred per your choice. The same pipeline can add them later without rework.
