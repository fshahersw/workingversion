# Apple Docket — Gap Report & Upload-to-Fill Pipeline

## Questions answered

**Does hash-based dedup ensure accuracy?**
Partially. sha256 is byte-exact, so it never produces false merges — but it *misses* re-rendered copies. In the pass we just ran, 17 of 18 duplicate groups had different hashes despite being the same filing (RECAP re-renders PDFs per download). The layered approach is the accurate one: slot + title + size matching (done) catches re-renders; hash matching catches same-file copies. Current state: **0 duplicate hashes among the 199 stored files** — the hash layer is already clean.

**Does it work on exhibit filings?**
Yes. Exhibits are separate document rows keyed by `(entry_number, attachment_number)`, so exhibit 272.1 dedupes independently from the main doc 272.0 and from exhibit 272.2. The same layered matching applies per-attachment.

## Gap inventory (verified against the registry)

- **222 document rows have no file** (metadata only), spanning **147 distinct entries** — e.g. entry 6 (Cecchi letter + proposed order), entry 17's 17 firm-resume exhibits, entry 18 (motion to appoint counsel)
- **24 entries are "T"-prefixed text-only entries** (minute entries, deadline settings, clerk QC messages) that never had PDFs on PACER/RECAP — these are expected file-less and will be excluded from the gap report
- 199 documents have files, all with sha256 — no hash duplicates

## Plan

1. **Export the gap report** → `/mnt/documents/apple-missing-files.csv`, one row per missing document:
   - `entry_number`, `attachment_number`, `date_filed`, `description`, `page_count` (known for 200 of 222)
   - `expected_filename` in RECAP convention: `gov.uscourts.njd.550383.<entry>.<attachment>.pdf` — this matches how locally downloaded PACER/RECAP files are typically named, so the user can map their ~333 local PDFs against it
2. **You upload the PDFs** (drag into chat, or a zip). Filenames don't need to match the convention — the ingestion script parses entry/attachment numbers from common naming patterns and falls back to matching by entry list.
3. **Ingest + fill gaps** — extend the existing `scripts/backfill/ingest_local_pdfs.py` flow:
   - Parse entry/attachment from each filename; match to the 222 gap rows by `(entry_number, attachment_number)`
   - Upload to the same S3 bucket under `recap-pdfs/68869775/`, compute sha256 + byte_count + page_count, update the existing document rows in place (no new rows — these rows already exist with correct metadata)
   - Report any uploaded files that don't match a gap (extra/new filings) separately before inserting
4. **Re-verify** — re-run the dedup scan + corpus health check; confirm Apple doc availability goes from 199/421 → target ~421/421 (minus anything genuinely unavailable on the docket).

## Technical details

- All work is on external corpus project `odwhzepghulspdzmzhhz`, schema `registry`, matter `447c8a03-748a-5de9-8e2d-e7018b0e63d3` (Apple, N.D. Cal. 5:24-md-03113 → RECAP docket `gov.uscourts.njd.550383` / NJD 550383 via MDL centralization)
- Gap CSV export: single read-only psql query; no schema changes
- Ingestion reuses existing AWS/S3 secrets (`S3_ENDPOINT`, `AWS_*`) and per-object upload (path-style, sigv4) already proven this session
- Updates use `run_sql`-equivalent scripted UPDATEs keyed by document UUID; nothing is deleted
