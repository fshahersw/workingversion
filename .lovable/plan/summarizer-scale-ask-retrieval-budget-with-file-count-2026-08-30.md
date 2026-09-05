# Summarizer: scale Ask retrieval budget with file count

## Current behavior (verified)

The Ask pipeline uses fixed budgets, independent of how many files are uploaded:

| Budget | Value | Where |
|---|---|---|
| Single-file Ask pages packed | 14 (`ASK_PACK`) | `src/lib/pile/limits.ts` |
| Pages per file in multi-file fan-out | 8 (`PER_FILE_ASK_PAGES`) | `limits.ts` |
| Files that get their own reader call | 12 (`MAX_FANOUT_FILES`) | `limits.ts` |
| Total pages handed to cross-file writer | 28 (`MULTI_ASK_PAGES`) | `limits.ts` |

So a 3-file pile and a 40-file pile both top out around 28–96 packed pages. Beyond 12 files, some files never even get a reader call. This is the ceiling you noticed.

## Plan: proportional budgets with a token-budget ceiling

### 1. Dynamic budget calculator
Add a `askBudget(fileCount)` helper in `src/lib/pile/limits.ts` that returns scaled values:

```text
files 1        -> single-file path, pack = 18 pages (up from 14)
files 2-5      -> fanout all files, 8 pages/file, writer pack up to 48
files 6-12     -> fanout all files, 8 pages/file, writer pack up to 72
files 13-30    -> fanout up to 20 files (top by search score), 6 pages/file, pack up to 96
files 31+      -> fanout up to 24 files, 5 pages/file, pack up to 110
```

Hard ceiling enforced by characters, not just page count: ~260k chars (roughly 65k tokens) of packed evidence, safely inside the writer model's context with room for the answer. Pages are trimmed by score, not by file order, so the best evidence survives.

### 2. Raise the fan-out ceiling
`MAX_FANOUT_FILES` becomes a tier-driven value (up to 24) instead of a fixed 12. `FILE_DIGEST_CONCURRENCY` rises from 4 to 6 so the wider fan-out doesn't slow wall-clock time — per-file reader calls use the fast model (Nemotron), so the added calls are cheap.

### 3. Selection for very large piles
When file count exceeds the fan-out tier, pick which files get reader calls by their per-file search score (`topScore` from `searchByFile`), not by upload order — files with no query relevance fall to the "not read" list, which the synthesis prompt already acknowledges as coverage limits.

### 4. Wire-through
- `pile-index.ts` `packAskByFile` / `packAsk`: accept the computed budget instead of reading constants directly.
- `ask.server.ts`: compute `askBudget(packCount)` once per request; pass per-file pages, fanout limit, and writer pack size into the existing stages. No signature changes to the SSE stream.
- Single-file path gets a modest bump (14 → 18 pages) so it isn't left behind.

### 5. UI honesty
The reasoning rail already reports per-file fan-out events; add one line to the "fanout" step showing the budget actually used (e.g. "reading 18 of 34 documents, 104 pages"), so scaling is visible rather than silent.

### 6. Tests
Extend `src/lib/pile/client-search.test.ts` with budget-table tests: file counts 1, 4, 12, 25, 60 produce the expected tiers, total packed chars never exceed the ceiling, and per-file fairness still holds.

## Out of scope
- Search hit counts stay per-file (`PER_FILE_HITS = 6`) — that's already proportional by design since every file contributes its own hits.
- OCR budgets unchanged.
