# Per-file search and cross-file synthesis

Yes — that makes sense, and it matches how the code works today. Right now every
query runs as a single pooled search over one index that contains every page of
every file (`PileIndex.search` → one BM25 ranking → top 12 hits, with only a
soft per-file cap in `diversifyHits`). Ask then packs whichever pages won that
one race and sends them to a single writer call. Consequences:

- A long file wins on volume; a short but decisive file can return zero hits.
- Term statistics are pooled, so a term that is rare in file B but common in the
  700-page file A looks "common" everywhere and loses weight.
- The writer sees a bag of pages, not "what each document says", so comparison
  and contradiction are incidental rather than structural.

The fix is a fan-out / fan-in shape: run the same query independently per file,
then cross-analyze.

## 1. Per-file retrieval (fan-out)

Search becomes per-file rather than pooled:

- Each file gets its own scoring pass with its own term statistics, so ranking
  inside a 12-page exhibit is not distorted by a 5,000-page PDF.
- Every file returns its own top-N (and an explicit "no match in this file"
  result when it has none) — a file can never be silently crowded out.
- Scores are normalized per file before any cross-file ordering, so "best hit in
  each document" is comparable.

Results in the workbench are grouped by document: one collapsible block per
file, showing its hit count, its best hits with page anchors, or a "no matching
passage" line. A flat "all hits by score" toggle stays available.

## 2. Per-file reading, then cross-file synthesis (fan-in) for Ask

Ask becomes two stages instead of one call:

**Stage A — read each file on its own (parallel).** For every file that produced
hits, its own retrieval pack goes to a per-file reader call: what does *this
document* say about the question, with page citations, plus an explicit "not
addressed in this file" when it isn't. These run concurrently with a bounded
pool, and a failed file is reported as failed instead of killing the run.

**Stage B — cross-analyze and synthesize.** The per-file digests (short, cited,
never raw page dumps) go to the writer with an explicit comparison job: where
the documents agree, where they contradict, what only one file says, what is
missing everywhere. Citations stay anchored to the original file and page, so
the source panel keeps working unchanged.

For a single-file pile, Stage A is skipped and behavior is exactly as today —
no added latency or cost when there is nothing to compare.

## 3. What you see while it runs

The reasoning rail gains real per-file structure: one row per document moving
through `searching → N passages → read → digested`, then a synthesis row. So
"which of my 14 files actually contributed" is visible rather than inferred.

## Technical notes

- `src/lib/pile/pile-index.ts`: add a per-file partition of the postings
  (file-scoped doc counts/lengths) and `searchByFile(query, perFileK)` /
  `packAskByFile(query)` returning `{ fileId, fileName, hits, pages, matched }[]`.
  Existing pooled `search`/`packAsk` stay for the single-file path and tests.
- `src/lib/pile/pile.worker.ts` + `pile-client.ts`: new `searchByFile` and
  `packAskByFile` ops, same RPC shape and in-thread fallback.
- `src/lib/pile/ask.server.ts`: split into `readFileDigest` (fast model,
  per-file, bounded concurrency) and `synthesizeAcrossFiles` (existing Claude
  writer, new comparison system prompt); emit new SSE events `file_read`,
  `file_digest`, `synthesis` alongside the current `retrieve`/`delta`/`done`.
- `src/routes/api/pile/ask.ts`: pass per-file packs through; unchanged contract
  for single-file piles.
- `src/lib/use-pile.ts`: `search` stores grouped results; `ask` sends per-file
  packs and tracks per-file step state.
- `src/components/summarize/SummarizeView.tsx` + `ReasoningRail.tsx`: grouped
  source list with a flat toggle, per-file progress rows.
- `src/lib/pile/limits.ts`: `PER_FILE_HITS`, `FILE_DIGEST_CONCURRENCY`, and a
  cap on how many files enter Stage A on very large piles (rest fall back to
  pooled retrieval so a 120-file pile doesn't fan out into 120 model calls).
- Tests extend `client-search.test.ts` / `retrieve.test.ts`: a short file with
  the only true match must surface even next to a huge noisy file.
