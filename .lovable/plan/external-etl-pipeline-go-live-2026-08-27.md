# External ETL Pipeline Go-Live

## Current state (verified)
- Contract v1.0 is finalized: manifest-authoritative, composite identity `(matter_id, docket_source, entry_number, attachment_number)`, no filename parsing.
- HTTP endpoints are live:
  - `POST /api/public/ingest/batches`
  - `POST /api/public/ingest/batches/{id}/validate`
  - `POST /api/public/ingest/batches/{id}/commit`
  - `GET /api/public/ingest/batches/{id}`
- Authentication uses `X-Ingest-Key` shared secret.
- Golden sample passed local validator and end-to-end self-test.
- Python runner (`scripts/pipeline/run_batch.py`) processes queued batches.
- Pipeline observability UI exists at `/pipeline` for the owner email only.

## Before you send real matters
1. **Get the production endpoint URL**
   - Use the published site URL + `/api/public/ingest/batches`, not `localhost:8080`.
2. **Share the ingest key securely**
   - The external pipeline needs the value of `INGEST_API_KEY`.
3. **Confirm runner invocation model**
   - `run_batch.py` does not auto-trigger on commit; it must be run on a schedule or called manually.
4. **Run a staging pilot**
   - Send one small matter first, validate, commit, then run `run_batch.py --batch <id>`.
5. **Verify display in the app**
   - Check the matter appears in `/matters` with correct docket entries and documents.

## Known operational constraints
- Presigned upload URLs expire after 1 hour.
- `validate` is idempotent and can be re-run after re-uploading fixes.
- `commit` is one-way: it marks the batch `queued` for the runner.
- Duplicates use the idempotency key, not the matter slug.
- No automatic email/webhook on completion unless `callback_url` is provided.

## Recommended next step
Run one real small matter end-to-end from the external pipeline, manually invoke the runner, and confirm the matter renders correctly before scaling up.
