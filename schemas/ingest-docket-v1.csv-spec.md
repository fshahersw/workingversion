# `docket.csv` column spec — contract v1

UTF-8, RFC 4180, comma delimited, `"` escaping, **header row required**, column
order irrelevant, unknown columns rejected as `invalid_field`. One row = one
**document slot** (a main document or one attachment).

| Column | Type / format | Required | Notes |
| --- | --- | --- | --- |
| `record_id` | string | optional | Your own row ID; echoed back on every reject. Strongly recommended. |
| `docket_source` | `main` \| `jpml` \| `state` \| `appellate` | yes | Must be declared in `manifest.dockets`. Replaces the old 900000 JPML offset. |
| `entry_number` | integer ≥ 0 | yes | The number **as printed on that docket**. Never offset it. |
| `entry_label` | string | yes | Printed label for **this slot**, e.g. `12` for the main document, `12-1` for its first attachment, `JPML 3`. |
| `attachment_number` | integer 0–999 | yes | `0` = main document; `1..n` = attachments in printed order. |
| `filed_date` | `YYYY-MM-DD` | yes | Must be identical on every row of the same entry. |
| `description` | string | yes for `attachment_number=0` | Full docket text. Newlines allowed inside quotes. |
| `document_title` | string | optional | Defaults to the entry label + description head. |
| `document_type` | string | optional | Free-text label from the source. |
| `doc_type` | enum | optional | Canonical classification; see the enum list in `src/lib/ingest/schema.ts`. Inferred when absent. |
| `availability` | `free_pdf` \| `locally_supplied` \| `pacer_link` \| `text_only` \| `sealed` | yes | Drives whether a PDF is required. |
| `file_name` | string | required iff `availability` ∈ {`free_pdf`,`locally_supplied`} | Opaque key matching an uploaded object exactly; must be unique in the batch and must be empty otherwise. |
| `page_count` | integer ≥ 1 | required with a file | Verified against the PDF. |
| `size_bytes` | integer ≥ 1 | required with a file | Verified against the staged object. |
| `sha256` | 64 lowercase hex | required with a file | Verified against the staged object. |
| `sha1` / `md5` | hex | optional | Stored for provenance only. |
| `is_sealed` | `true`/`false` | optional (default `false`) | |
| `recap_pdf_url` | https URL | optional | |
| `internet_archive_url` | https URL | optional | |
| `courtlistener_document_url` | https URL | optional | |
| `pacer_pdf_url` | https URL | optional | |
| `pacer_price_usd` | number ≥ 0 | optional | |

## `parties.csv`

| Column | Required | Notes |
| --- | --- | --- |
| `party_name` | yes | |
| `party_role` | optional | Plaintiff / Defendant / Interested Party … |
| `representation` | optional | |
| `attorney_name`, `attorney_designations`, `attorney_phone`, `attorney_fax`, `attorney_email`, `firm_name`, `firm_address`, `attorney_full_details` | optional | One row per attorney; the party is de-duplicated by name. |
