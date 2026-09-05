# Repair the Apple filing register from the authoritative docket ledger

## Confirmed findings

- The uploaded ledger contains **427 unique rows**, covers numbered entries **1–292**, and has a date on every row.
- The filing register sorts `registry.docket_entries.entry_number` as text. That makes descending order lexicographic, which is why entry **99** can appear ahead of **292**.
- The current Apple corpus has **409 document rows** and **288 docket-entry rows**.
- Against the ledger, the current data has:
  - **22 matched document slots** with a missing filing date
  - **11 matched slots** with a conflicting date
  - **244 matched slots** where the ledger has a more complete title
  - **40 ledger document slots** absent from the canonical document table
  - **4 numbered entries** absent from the docket-entry table: 267–270
  - **24 unnumbered docket events** identified by stable ledger IDs such as `...-00284-t001`
- Existing PDF/object links must be preserved; this CSV is an authoritative metadata ledger, not a replacement PDF set.

## Implementation

### 1. Add a reusable ledger import and audit script

Create a focused Apple-compatible CSV importer that:

- accepts the uploaded columns `document_id`, `docket_sheet_number`, `attachment_number`, `date`, and `title`
- parses dates strictly as `MM/DD/YYYY`
- normalizes harmless HTML such as `<hr>` without discarding legal notice text
- validates duplicate source IDs, duplicate entry/attachment slots, invalid dates, and malformed rows
- matches numbered rows by `(matter_id, entry_number, attachment_number)`, treating a blank attachment as the main document
- retains the CSV `document_id` as source provenance for deterministic reruns
- produces a dry-run report before any database write

### 2. Promote ledger metadata safely into canonical registry tables

Use a staging table and one transactional, idempotent promote script to:

- update every numbered docket entry's authoritative `date_filed`
- update every numbered document's `entry_date_filed`
- replace generic, blank, truncated, or demonstrably stale titles with the fuller ledger title
- set the docket-entry title from the main ledger row while preserving attachment-specific titles on document rows
- insert missing docket entries, including 267–270
- insert metadata-only document rows for the 40 absent ledger slots, linked to the correct docket entry and marked unavailable until a PDF is matched
- preserve all existing `s3_bucket`, `s3_key`, hashes, page counts, download URLs, and availability flags
- reconcile duplicate registry rows by selecting a canonical row per entry/attachment slot, preferring the row with a stored PDF and richest metadata; flag redundant rows rather than deleting them
- import the 24 `t###` rows as distinct unnumbered docket events with stable provenance, without pretending they are attachments or numbered filings
- refresh docket document counts, PDF flags, filing categories, and entry-level rollups

### 3. Fix ordering and date rendering in the filing register

Update the filing query so:

- **Newest entry first** uses numeric entry ordering, not text ordering
- numbered filings sort `292, 291, 290…`
- unnumbered docket events have a deterministic secondary position based on filing date/source sequence
- **Newest entered** uses the database `date_filed` column rather than trying to parse an `(Entered: …)` suffix from description text
- filing cards render the canonical filing date even when the title contains no entered-date suffix
- pagination remains stable with explicit tie-breakers

### 4. Verify the repair

Run the importer in dry-run mode, review its reconciliation counts, then promote and re-audit Apple. Acceptance checks:

- entry 292 is the first result under **Newest entry first**
- entries 292–287 show their August 2026 dates and complete ledger titles
- entry 99 remains dated September 5, 2025 but no longer appears first
- no numbered ledger row is missing from the filing register
- all numbered docket entries and documents have ledger-backed dates
- every imported title matches the normalized ledger title at the appropriate entry/attachment level
- existing PDF download links still work
- rerunning the import makes no additional changes

## Technical details

- Add a dedicated ledger staging/promote SQL path under `supabase/corpus/`; do not overload the local-PDF importer because this file includes metadata-only and unnumbered docket activity.
- Extend the registry query projection to include `date_filed` and map it directly to `CorpusFiling.enteredAt`.
- For numeric ordering through the REST data layer, add a registry view or sortable numeric column exposed to the API, then order by numeric entry plus stable secondary keys.
- Keep all changes scoped to the external corpus registry and the Matters filing-register frontend; do not change auth, agent endpoints, or document storage.
