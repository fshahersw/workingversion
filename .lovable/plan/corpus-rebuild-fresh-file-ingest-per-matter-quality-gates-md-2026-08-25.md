# Corpus rebuild — fresh-file ingest, per-matter quality gates, MDL workspace

Rebuild the matter corpus on a clean schema, populated **only from the fresh document sets you provide** — nothing is copied from the old registry database. Three matter shells (Apple, Insulin Pricing, Roundup) are created now and stay empty until you upload each docket's files.

## What changes from the old approach

- **No reuse of the old database.** The Apple pilot rows just created from the old registry are wiped. Every docket entry and document in the new corpus comes from your uploads (PDFs + a docket ledger CSV per matter), with CourtListener used only as an optional gap-check reference.
- **Embeddings: voyage-law-2 (1024 dimensions)**, called directly with your own Voyage API key. No Lovable AI anywhere. Vectors live in `pgvector` inside your own corpus database. `voyage-law-2` is purpose-built for legal text — better retrieval quality for filings than a general model.
- **No "All Matters" page.** A sidebar MDL selector opens a command-style modal listing matters available to you; selecting one switches the whole workspace to that matter.
- **Dense matter workspace** modeled on your reference: matter header + tabs (Matter Ledger, Documents) + in-page expanding document viewer with file-type filtering.

## Already in place (done, verified)

- New `corpus` schema in your database: `matters`, `docket_entries` (integer entry numbers — sorting is natively correct), `documents` (sha256, pages, sealed flag, doc type), `parties`, `counsel`, `doc_chunks` (1024-dim embeddings + filter metadata), `ingest_runs`, plus a `match_doc_chunks` search function that applies metadata filters before similarity ranking.
- `matters` storage bucket (private) with a standard layout: `<matter>/pdf/…`, `<matter>/text/…`, `<matter>/incoming/…`.
- Pipeline script skeleton (`scripts/pipeline/ingest_matter.py`) — staged, resumable, idempotent, with per-stage run logging.

## Work plan

### 1. Reset and create the three shells
- Delete the Apple pilot rows (316 entries copied from the old registry).
- Create three bare matter rows from public-record bibliographic data only (name, docket number, court): Apple Smartphone (2:24-md-03113, N.D. Cal.), Insulin Pricing (3:23-md-03080, D.N.J.), Roundup (3:16-md-02741, N.D. Cal.). No docket entries, no documents.

### 2. Pipeline adjustments
- Embedding model switched to **voyage-law-2** (1024-dim, matches the schema).
- Sources reduced to: your uploaded files only (`--local-dir` / bucket `incoming/` folder). Old-registry and recap-folder sourcing removed.
- Add a **ledger-CSV entry builder**: the docket sheet you provide per matter (like the Apple one) becomes the authoritative source for entry numbers, dates, and descriptions.
- Filename parsing for both naming styles (`001. (05-01-2024) Title.pdf` and RECAP `gov.uscourts.*.1.0.pdf`).

### 3. Upload surface in the app (so you can hand me the docs)
Chat attachments cap at 20MB/10 files, which can't carry a full docket. Instead:
- An **Upload documents** dropzone inside each matter workspace: multi-file/folder drag-drop, browser uploads straight to `matters/<slug>/incoming/` via presigned URLs (no size bottleneck, resumable, progress bars).
- One-time bucket CORS configuration so browser uploads work.
- Once you say a matter's upload is done, I run the pipeline: match → store → write → extract → embed → verify.

### 4. MDL selector + matter workspace
- Sidebar: "MDL" selector item (with the current matter name) opens a command-style modal — searchable matter list; selecting one switches the workspace.
- Workspace layout (dense, compact, aligned — your reference's style, our brand):
  - **Header**: matter name, docket/court/judge chips, status/stage badges, document and entry counts.
  - **Tabs**: `Matter` (ledger — entry #, date, description, type chip, page count, PDF badge; sortable, filter chips by type) and `Documents` (flat list with file-type filter).
  - **In-page viewer**: clicking a row expands the PDF inline (smooth height animation), side panel toggle, zoom/download; citation chips and timeline links jump straight here.
  - **Right rail** (collapsible): matter details, parties & counsel, key dates.
- The old Matters table page is removed; `/matters` redirects to the workspace.

### 5. RAG + agent wiring (after first matter verifies)
- `search_corpus` agent tool switches to `match_doc_chunks` with matter scoping from the workspace, doc-type/date filters inferred from the query, and results returned with page-span citations (entry, attachment, pages).
- Rerank: filter by metadata → vector similarity on voyage-law-2 embeddings → top chunks to the writer agent with exact citations.
- Dictation transcription rerouted off Lovable AI (direct provider call, key via secrets).

### 6. Per-matter verification gate
A matter only goes live when: all entries dated and described, every document row has its PDF, sha256 + page counts complete, text extracted and chunked, embeddings complete. Report per matter (counts + missing-file CSV) after each run.

## Sequencing

1. Reset + three shells + pipeline adjustments.
2. App: upload dropzone, MDL selector, workspace skeleton (works against empty shells).
3. **You upload the first docket's files** (I'll tell you when ready — that's the signal).
4. I run the pipeline for that matter; we review the verification report together.
5. Repeat per matter. Agent RAG cutover once the first matter is live. Old `registry` schema retired only after all three are verified.

## What I need from you

1. **Voyage API key** — I'll send a secure secret prompt for `VOYAGE_API_KEY` when we reach the embed stage.
2. **Files per matter**, when I signal readiness: the full PDF set (any folder structure) plus the docket ledger CSV if you have one (the Apple-style one is perfect).
3. One dashboard click I flagged earlier: adding `corpus` to the exposed schemas in your database API settings — I'll confirm if it's still needed after the reset.

## Technical notes

- Schema `corpus`, 8 tables, `vector(1024)` — unchanged, already applied.
- Non-numeric docket labels ("T5") keep their display label and sort into a reserved 900k numeric range.
- Dedup remains slot-based: one canonical PDF per (entry, attachment).
- Old registry schema stays untouched until cutover is complete and verified.
