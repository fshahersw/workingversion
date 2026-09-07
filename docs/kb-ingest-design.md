# Per-User Document KB — Ingest, Chunking, Embedding, Retrieval (design)

Status: ASYNC-BDA IMPLEMENTED LOCALLY (not deployed or migrated), 2026-09-06.

> **NO DEPLOY / NO MIGRATION:** The implementation is source plus local
> validation only. No AWS invocation, change set, artifact upload, stack
> deployment, or application of `0002_kb_async_ingest.sql` was performed.

Frontier-quality bulk document analysis for the **Discovery → Working Set** tab.
Users upload up to **100 files / 20,000 pages** of mixed types (native PDF, scanned
PDF, DOCX, XLSX, PPTX, images/screenshots, TXT) and expect fast, accurate,
citation-grounded search and bulk analysis. This doc specifies the pipeline that
turns any file into consistent, table-aware, page-anchored, retrievable chunks and
the query paths over them.

Everything is in-account (AWS 475976462949, us-east-1), SigV4 default credential
chain, no external egress (no Voyage, no Groq), HIPAA-disciplined.

Related: [[seegerweissai-discovery-kb]] (current-state map + KB decision),
[[seegerweissai-bedrock-models]] (model catalog/tiering), `docs/subagent-research-design.md`.

## 0. Decisions (locked)

- **Store:** Amazon Aurora PostgreSQL Serverless v2 + pgvector (HNSW).
- **Ingest compute:** SQS + **Lambda** orchestration (NOT Fargate). BDA does the heavy
  conversion managed/async, so the worker only orchestrates (invoke BDA → chunk →
  embed → Aurora) and never blocks — no torch container, no cluster. Background/queue
  work cannot run on the Cloudflare/nitro scaffold; this is AWS compute with a scoped
  IAM role.
- **Scope:** Working Set tab ONLY. Schema is keyed by `(owner_sub, workspace_id,
surface)` with `surface ∈ {workingset, deposition, review}` so Deposition and
  Tabular Review adopt the same store later with no schema rework.
- **Conversion:** **BDA-first.** BDA converts all PDF (native + scanned) / image /
  DOCX uploads → markdown + per-table CSV + confidence. SheetJS for XLSX, direct parse
  for TXT/MD, PPTX→PDF→BDA. Docling/Fargate DROPPED. VL models are an OPTIONAL
  escalation for pages BDA flags low-confidence.
- **Embeddings:** Titan Text Embeddings V2, computed at ingest and persisted.
- **Rerank:** in-account Bedrock Rerank (cohere.rerank-v3-5:0).
- **Cheap analysis workhorse:** Nemotron Nano 3 30B (fallback Nova 2 Lite). No Groq,
  no external egress.

## 1. Canonical document (the one consistent format)

Every file, whatever its type, converts to a single shape. Chunking / embedding /
retrieval never branch on source type.

```
CanonicalDoc = { docId, sha256, fileName, mime, pageCount, pages: Page[] }
Page  = { pageNo, blocks: Block[], source: "text"|"ocr"|"docling"|"bda" }
Block = {
  kind: "heading"|"para"|"list"|"table"|"figure",
  text: string,                 // verbatim (NEVER summarized — needed for quote-verify)
  level?: number,               // heading depth
  table?: { header: string[], rows: string[][], caption?: string },
  bbox?: [x0,y0,x1,y1],         // when available, for pinpoint
  conf: number                  // 0..1 extraction confidence
}
```

- **Page is the citation anchor** — the whole app already cites `fileId:page`.
- **Tables are first-class**: kept structured, serialized to GFM only at pack time.
- Non-paginated sources get synthetic page anchors: XLSX sheet = 1 page; TXT/MD =
  ~3k-char windows numbered as pages.
- `conf` + `source` propagate to chunks so retrieval can down-weight low-confidence
  OCR and the UI can flag it.

## 2. File → canonical: routing matrix

| Input                             | Converter                       | Notes                                                                             |
| --------------------------------- | ------------------------------- | --------------------------------------------------------------------------------- |
| PDF (native + scanned)            | **BDA**                         | markdown + per-table CSV + figure crops + per-page confidence                     |
| Image / screenshot (png/jpg/tiff) | **BDA**                         | OCR + tables + confidence; VL escalation if low-conf                              |
| DOCX                              | **BDA** (internally → PDF)      | native tables preserved                                                           |
| XLSX                              | SheetJS                         | structured cells/sheets — NOT OCR; one `table` block per sheet, row-range anchors |
| PPTX                              | LibreOffice/soffice → PDF → BDA | per-slide; rare in litigation                                                     |
| TXT / MD                          | direct parser                   | —                                                                                 |

**BDA is the single first-class converter** for all document-shaped uploads (PDF
native + scanned, images, DOCX) — the vast majority of legal uploads. Managed, async,
3,000-page splitter (each split ≤20 pp), 200 MB console / 500 MB API →
structural markdown + per-table CSV + figure crops + **per-page confidence**.
~$0.01/page (trivial vs attorney time), no infra to run. This deletes Docling +
the Fargate/torch cluster from the design.

Only **XLSX / PPTX / TXT** fall outside BDA:

- **XLSX** is structured data — parse natively (SheetJS), do not OCR. One `table`
  block per sheet, row/col anchors; large sheets → row-group chunks (§4).
- **PPTX** (rare) → `soffice --headless` convert to PDF → BDA. Defer if unneeded in v1.
- **TXT/MD** → trivial direct parse.

**VL pool is now escalation-only:** BDA emits per-page confidence; pages below a
threshold route to the VL pool (§3) for a second pass or to human review. No blanket
per-page vision. The client's `isLowQualityText` gate still guards the instant
client-side pre-index, but the durable source of truth is BDA output.

## 3. Vision tier (escalation only)

BDA is the primary OCR path (§2). The VL pool is a SECOND pass for pages BDA flags
low-confidence, and for standalone screenshots where visual reasoning beats OCR.
All in-account, verified IDs:

- **Primary bulk:** `amazon.nova-2-lite` — **flat 230 tokens/image** (predictable
  cost), 1M ctx; **5 images/request** embedded (≤25 MB payload) OR up to **1000 via
  S3 URI**; PNG/JPEG/GIF/WebP; auto-rescaled (one side ≥896px, ≤8000×8000).
- **Escalation (hard visual reasoning):** `qwen.qwen3-vl-235b-a22b` (256K) or
  `nvidia.nemotron-nano-12b-v2` VL (128K) — both text+image via Converse. Note: these
  bill by **actual image tokens** (size-dependent, less predictable than Nova's flat
  230), so reserve for pages Nova flags low-confidence.
- **Cost control:** downscale renders to ~1500px longest edge, JPEG q80; cache by
  page-image sha (re-ingest / re-OCR free); pack up to 5 page-images per Nova Converse
  call, or stage to S3 and pass URIs for larger batches.
- **Prompt contract:** emit canonical markdown (headings, paragraphs, GFM tables,
  `[figure: ...]`), verbatim, never prose-summarize.
- Bounded concurrency + AIMD backoff (pattern already in `pile/limits.ts`); VL shares
  the model's on-demand TPM/RPM quota and WILL 429 under parallel fan-out.

## 4. Chunking (structure-aware + table-aware + contextual)

Not blind fixed-width windows.

- **Prose:** split on section/heading → paragraph groups; ~512-token target; ~15%
  token overlap WITHIN a section only (no overlap across headings or pages).
- **Tables:** each table is its own chunk; large tables split into row-groups with
  the **header row repeated in each** so every chunk is self-describing; caption /
  section heading prepended.
- **Contextual retrieval (Anthropic technique):** before embedding, prepend a
  one-sentence context line generated by the cheap workhorse (Nemotron Nano 3):
  "From {doc}, section {heading}, re: {topic}." Lifts recall on ambiguous chunks;
  generated in the same batched parallel pass. Store the context separately so the
  displayed/quoted text stays verbatim.
- Every chunk carries `page_start/page_end` (+ block offsets when available).
- Deterministic + CPU-cheap → fully parallel per page.

## 5. Embedding

- **Titan Text Embeddings V2** (`amazon.titan-embed-text-v2:0`), `normalize:true`,
  persisted at ingest (not per-query). Dims: **1024** (default/quality); 512/256 are
  storage-latency levers. Max input **8,192 tokens / 50,000 chars** — chunks are well
  under this.
- **No real-time batch endpoint** — `inputText` is one string per InvokeModel call.
  So: interactive ingest = bounded concurrency pool of single calls + exponential
  backoff/jitter (expect 429 near the per-model RPM ceiling; verify quota in Service
  Quotas console). Very large offline loads = **Bedrock Batch inference** job (input
  ≤1 GB) to sidestep throttling entirely. 20k chunks parallelized to the RPM ceiling
  finishes in minutes.
- Cache by chunk sha (dedup + re-ingest free).

## 6. Aurora schema + hybrid search

```sql
-- vectors + lexical live together so hybrid is one round trip
create table kb_documents (
  doc_id       uuid primary key,
  owner_sub    text not null,
  workspace_id uuid not null,
  surface      text not null,           -- workingset|deposition|review
  file_name    text not null,
  sha256       text not null,
  mime         text,
  page_count   int,
  s3_key       text,                    -- durable page text/markdown (SSE-KMS)
  status       text not null,           -- queued|converting|embedding|ready|error
  created_at   timestamptz default now(),
  unique (owner_sub, workspace_id, sha256)
);

create table kb_chunks (
  chunk_id     bigserial primary key,
  doc_id       uuid not null references kb_documents(doc_id) on delete cascade,
  owner_sub    text not null,
  workspace_id uuid not null,
  surface      text not null,
  page_start   int, page_end int,
  kind         text,                    -- para|table|heading|list|figure
  content      text not null,           -- verbatim, displayed/quoted
  context      text,                    -- contextual-retrieval prefix (embed-only)
  conf         real,
  tsv          tsvector,                -- BM25 leg
  embedding    vector(1024)             -- HNSW
);

create index on kb_chunks using hnsw (embedding vector_cosine_ops);
create index on kb_chunks using gin (tsv);
create index on kb_chunks (owner_sub, workspace_id, surface);

-- RLS: tenant = verified Cognito sub, set per connection from the request principal
alter table kb_chunks    enable row level security;
alter table kb_documents enable row level security;
create policy kb_chunks_owner on kb_chunks
  using (owner_sub = current_setting('app.user', true));
-- (shared workspaces later: OR membership check against a members relation)
```

`kb_hybrid_search(query_text, query_embedding, owner, workspace, surface, k)` — clone
the existing `corpus_hybrid_match_chunks` shape: pgvector kNN + `ts_rank` BM25 fused
by RRF (constant 60) in one SQL call, scoped by `(owner_sub, workspace_id, surface)`.
Per-file candidate pooling so a 5,000-page PDF can't drown a short exhibit (keep the
good per-file design from today's `pile-index.ts`).

## 7. Ingest pipeline (implemented async-BDA slice)

```
saveWorkspaceFn / POST /api/kb/ingest
  -> browser computes raw-byte SHA-256 with Web Crypto
  -> browser PUTs bytes to uploads/<sub>/... using a checksum-bound signed header
  -> reserve named workspace + one WSDOC child per expected document
  -> register kb.documents(status=queued) under withPrincipal(<sub>)
  -> conditionally reserve dedicated ingest job
     (owner/doc/workspace/request+source hashes/owned keys; no content/file name)
  -> HeadObject verifies S3 checksum + byte size without reading the object body
  -> BDA-eligible (PDF/image/DOCX): InvokeDataAutomationAsync(S3 in, S3 out)
       deterministic clientToken
       notificationConfiguration.eventBridgeConfiguration.eventBridgeEnabled=true
       output kb/bda-output/<sub>/<docId>/
       status=converting ; browser may close
  -> XLSX/TXT: parse inline (fast) -> straight to chunk stage
BDA success/client-error/service-error (best effort):
  -> EventBridge input transform -> compact SQS event
     {version, invocationArn, outcome, correlationId}
  -> bounded Lambda exact-gets job alias + principal mapping
  -> every Aurora operation uses withPrincipal(ownerSub)
  -> GetDataAutomationStatus + validate owned output prefix
  -> read result.json/markdown -> canonical blocks
  chunk:   per-page, table-aware                          -> chunk rows
  context: deterministic document/section/page prefix     -> chunk.context
  embed:   Titan v2, bounded-concurrency pool + backoff   -> chunk.embedding
  persist: pages -> kb/pages/<sub>/<docId>.json; atomically replace chunks
  status: child ready -> aggregate parent -> job ready
Scheduled reconciliation:
  -> StatusUpdated GSI finds stale queued/converting/embedding jobs
  -> queued/no ARN: repeat deterministic InvokeDataAutomationAsync and attach alias
  -> converting/embedding: GetDataAutomationStatus
     -> enqueue the same compact idempotent event
```

- **No Fargate, no torch, no Docling, no Step Functions.** BDA runs separately;
  one SQS record finishes one bounded document. Page/markdown/chunk ceilings
  fail closed before Lambda's 15-minute limit.
- Document and chunk writes are idempotent. Duplicate EventBridge/SQS delivery
  is lease/condition protected; an atomic replace prevents stale tail chunks.
- BDA direct service events are best effort. SQS has partial batch failure,
  bounded event-source concurrency, encryption, TLS-only policy, redrive/DLQ,
  EventBridge target retries/DLQ, and age/error/throttle/delivery alarms.
- The dedicated job table is CMK encrypted with PITR, TTL, deletion protection,
  and a `StatusUpdated` GSI. It stores owner and owned coordinates but no
  document content or file name. The queue never carries the owner.
- Embed stage: bounded concurrency (Titan has no real-time batch) + backoff, or a
  Bedrock Batch inference job for very large offline loads.
- Client model mirrors the proven scratch flow: presign upload → poll progress →
  search. Instant client BM25 pile covers the gap while BDA runs.
- Parent workspaces aggregate per-document checkpoints and cannot become ready
  until every expected document succeeds. Pending deletion removes exact job
  mappings first; already-running BDA work is not assumed cancellable and may
  require lifecycle cleanup if it writes after deletion.
- IAM: app starts BDA and writes exact job mappings; worker reads BDA output,
  invokes only the configured embed model, updates owner checkpoints, and uses
  the Data API/`kb_app` secret. No static credentials. Events, logs, metrics,
  and DLQ payloads exclude principals, file names, page/document text, and raw
  service errors.

## 8. Retrieval + bulk query (two modes)

Reading every doc per question does not scale to 20k pages. Two explicit modes:

1. **Search & Answer (default, scales):** `kb_hybrid_search` across all in-scope
   files → **pre-truncate the fused pool to ~150 candidates** → Bedrock Rerank
   (`cohere.rerank-v3-5:0`, 1 query/call, ≤1000 docs/call, 4K-token window, ~10 RPS)
   → top K → synthesize with `[S#]` citations. Reads only relevant slices; 100 files
   ≈ as fast as 5.
2. **Analyze Every Document (toggle, exhaustive):** map-reduce fan-out — parallel
   per-file reader (Nemotron Nano 3, cheap/fast) → cross-analysis synthesis
   (Sonnet 5 / Opus 4.8). For "summarize each deposition" / "every mention of X."
   Show coverage + cost; surface **"N of M docs individually read."**

- Keep the client-side BM25 pile as an **instant** layer; it hydrates from and
  writes through to the KB (durable, cross-device, shareable).
- Query expansion from structure terms (already in `pile/retrieve.ts expandQuery`).
- **Accuracy:** keep the deterministic `quoteOnPage` citation verifier (model-free).

**Bulk UI/UX:** multi-select docs + "restrict to these" (RefineRail already has
per-file restrict), a scope pill (All / Selected), and the mode toggle. Auto-grouping
(matter/party/doc-type/cluster) is a v2 enhancement, not core.

## 9. Security / isolation

- Tenant key = verified Cognito `sub` from `getUserFromRequest`; never trust a
  client-supplied id. Set `app.user` GUC per connection → RLS enforces scope.
- Do NOT inherit the corpus service-key-bypasses-RLS pattern.
- S3 SSE-KMS at rest, Aurora KMS, TLS, IAM DB auth. No page text / embeddings in
  CloudWatch.
- Fix the shared-workstation leak independently and early: namespace the pile's
  IndexedDB key by `sub` (today it's a fixed `"current"`).

## 10. Phasing

- **P1 Aurora + schema:** stand up Serverless v2 + pgvector; tables above;
  `kb_hybrid_search`; RLS. Plus the IndexedDB per-user-key fix (small, ships now).
- **P2 Ingest service:** `/api/kb/ingest` (presign) + SQS + Lambdas; BDA invoke for
  PDF/image/DOCX + EventBridge completion; SheetJS for XLSX; canonical format; VL
  low-confidence escalation; contextual chunking; Titan embed; S3 + Aurora persist;
  progress polling. No Fargate/Docling.
- **P3 Retrieval:** `/api/kb/search` (authorize → hybrid → cohere.rerank);
  Working Set hydrates from / writes through to KB; keep client BM25 instant layer.
- **P4 Bulk modes + UI:** Search&Answer + Analyze-Every-Document toggle; doc-scope
  selection; coverage signal.
- **P5 Workspaces + sharing** (DynamoDB `WS#` items) — separate doc.

## 11. Verified limits (2026-09-06, official AWS docs)

- **Titan v2:** 8,192 tok / 50k char input; dims 1024/512/256; `normalize` default
  true; single-text-per-call (no real-time batch — use a pool or Batch inference).
- **Bedrock Rerank:** `cohere.rerank-v3-5:0` + `amazon.rerank-v1:0`; 1 query/call,
  ≤1000 docs/call, 4K-token window, ~10 RPS; billed per 100-doc batch.
- **Nova 2 Lite:** 5 images/req embedded (≤25 MB) or ≤1000 via S3; flat 230 tok/img;
  ≥896px / ≤8000² ; PNG/JPEG/GIF/WebP; also takes PDF/DOCX (5 docs/req, ~2,560 tok/PDF
  page).
- **VL escalation IDs:** `qwen.qwen3-vl-235b-a22b` (256K), `nvidia.nemotron-nano-12b-v2`
  VL (128K) — both Converse image input; bill by actual image tokens.
- **BDA:** ≤3,000 pp/doc with splitter (else 20), 200 MB console / 500 MB API,
  PDF/TIFF/JPEG/PNG/DOCX → markdown + per-table CSV + figure crops + confidence;
  ~$0.01/page; GA us-east-1.
- **Docling:** Python 3.10+, torch-heavy, GPU optional (CPU fine, OCR slow on CPU);
  CPU OCR backends EasyOCR/Tesseract/RapidOCR; Fargate = no GPU → CPU-only.

## 12. Still open / verify-at-build

- Titan v2 **per-model RPM quota** for this account (Service Quotas console) to size
  the embed pool; likewise VL/Rerank on-demand TPM/RPM.
- Prod runtime confirmation for the app itself (nitro→AWS) so `/api/kb/*` and the
  Fargate worker share one deployment story.
- Whether the client-side extractor stays as a fast pre-index or is fully replaced by
  server ingest (leaning: keep as instant layer, server is source of truth).
