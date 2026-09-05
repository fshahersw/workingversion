# Bulk ETL ingestion guide + mock templates

## Goal
Deliver user-facing instructions and exact mock template files showing how and where to send matter content for the Seeger Weiss litigation-corpus bulk ETL pipeline.

## Deliverables
1. **Bulk ETL Ingestion Guide** (`/mnt/documents/etl-templates/bulk-etl-ingestion-guide.md`)
   - API endpoint + `X-Ingest-Key` authentication
   - Bundle anatomy: `manifest.json`, `docket.csv`, `parties.csv`, PDFs
   - End-to-end workflow: create batch → upload files → validate → commit
   - Exact field tables with type/format rules
   - CSV rules (RFC 4180, UTF-8, comma-delimited, quoted fields)
   - Matter slug rules and docket-source identity rules
   - File naming conventions and canonical S3 key derivation
   - Validation rules, required vs optional fields, common reject codes
   - cURL examples using placeholder values

2. **Mock template files** (`/mnt/documents/etl-templates/`)
   - `template-manifest.json` — fill-in-the-blank manifest following contract v1.0
   - `template-docket.csv` — docket rows covering all `availability` types
   - `template-parties.csv` — party rows with complete column set
   - `template-upload-list.txt` — ordered checklist of files in the bundle

3. **README index** (`/mnt/documents/etl-templates/README.md`)
   - Quick-start orientation and file map

## Approach
- Use the live contract (contract v1.0 in `src/lib/ingest/schema.ts`) as the single source of truth.
- Keep templates self-contained and copy-paste ready; every field present in the schema is represented.
- Use fictional "Example Mass Tort MDL" placeholders so the templates are obviously mock data.
- Write files to `/mnt/documents` so they are persistent and user-downloadable, with `<presentation-artifact>` tags surfaced in the response.

## Success criteria
- Guide explains the pipeline from zero to committed batch.
- Templates validate against the existing Zod schema when real values are substituted.
- A user can hand the template files and guide to an ETL vendor and get a correct submission.
