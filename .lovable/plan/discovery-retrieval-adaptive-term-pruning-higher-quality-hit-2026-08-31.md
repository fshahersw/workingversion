# Discovery retrieval: adaptive term pruning + higher-quality hit budgets

## Current behavior (verified in code)

| Setting | Value | Where |
|---|---|---|
| Search-tab hits per file | 6 (`PER_FILE_HITS`) | `src/lib/pile/limits.ts` |
| Passage candidates scanned per file | `max(perFileK*8, 32)` = 48 | `pile-index.ts` |
| Pooled diversity cap | 4/file (comparison queries) or 10/file | `retrieve.ts` |
| Ask pages, 1 file | 18 | `askBudget()` |
| Ask fan-out | 8 pp/file to 12 files; 6 pp to 20; 5 pp to 24 | `askBudget()` |
| Writer pack | 48 / 72 / 96 / 108 pages, hard-capped at 260k chars | `limits.ts` |
| Per-page text sent to reader | first 3,500 chars | `ask.server.ts` |
| Tokenizer | lowercase `[a-z0-9]+` + docket pattern; no stoplist, no stemming | `bm25.ts` |

Model note: the Ask pipeline's per-file readers run Nemotron Super 3 120B and the
cross-file writer already runs **Claude Sonnet 4.6** on Bedrock (`BEDROCK_PILE_WRITER_MODEL`).
GLM-5 is only an opt-in env override for the *research* writer, not this page. So no model
swap is needed for longer context here — Sonnet 4.6 is already the long-context writer.

## Changes

### 1. Adaptive IDF pruning (replaces a hand-written stopword list)

New `pruneQueryTerms()` in `bm25.ts`, applied at query time only — nothing is dropped
from the index, so exact captions and docket strings stay searchable.

- For each query term, compute `df / N` against the file's own index.
- Drop terms with `df/N > 0.6` **only when at least one selective term survives**.
  A query that is entirely common terms keeps all of them rather than returning nothing.
- Never prune a term that is numeric, contains a digit, matches the docket pattern,
  or is on a short protected list of legal-operative words (`not`, `no`, `shall`,
  `may`, `must`, `all`, `any`, `each`, `without`, `except`, `unless`).
- Pruning is per-file, so a term that is boilerplate in one 5,000-page PDF but rare in
  a short exhibit is still scored in the exhibit.

Side benefit: query latency stops walking near-universal posting lists on large piles.

Also fix `snippet()` in `pile-index.ts` to anchor on the surviving selective terms
instead of its current naive `length > 2` filter, so snippets stop centering on "the".

### 2. Higher hit budgets, kept high-quality

Target 15-20 genuinely relevant hits, not 20 padded ones.

- `PER_FILE_HITS` becomes a function of pile size, mirroring `askBudget`:

```text
1 file        -> 20 hits from that file
2-5 files     -> 10 per file  (20-50 pooled, trimmed to 20 shown)
6-12 files    -> 6 per file
13+ files     -> 4 per file
```

- Pooled `search()` returns up to **20** hits (was 12), with the diversity cap raised
  to 6/file for comparison queries and 12/file otherwise.
- Passage candidate scan per file rises from `max(k*8, 32)` to `max(k*10, 64)` so the
  per-page collapse has more passages to pick a best score from.
- **Quality gate:** after ranking, drop hits scoring below 25% of the file's own top
  score. This is what keeps "20 hits" from becoming "20 including 8 junk" — a file with
  only 3 real matches returns 3, not 10 padded ones.

### 3. Ask stays parallel, gets a wider fan-out

The fan-out / fan-in shape is unchanged: each file is read in its own Nemotron call in
parallel, then Sonnet 4.6 cross-analyzes. Only the budgets move:

```text
1 file      -> 24 pages (was 18)
2-5 files   -> 10 pp/file, writer pack 60   (was 8 / 48)
6-12 files  -> 8 pp/file,  writer pack 88   (was 8 / 72)
13-30 files -> 7 pp/file, 24 files, pack 110 (was 6 / 20 / 96)
31+ files   -> 6 pp/file, 30 files, pack 128 (was 5 / 24 / 108)
```

`MAX_FANOUT_FILES` ceiling rises to 30 and `FILE_DIGEST_CONCURRENCY` from 6 to 8, so the
wider fan-out does not add wall-clock time — per-file reads are cheap and parallel. The
260k-char writer ceiling stays as the real backstop; page counts are trimmed against it.

### 4. Tests

Extend `src/lib/pile/bm25.test.ts` and `client-search.test.ts`:
- pruning drops a term present in every doc but keeps "not" and docket numbers
- an all-common-terms query still returns results
- per-file hit tiers produce the expected counts at 1 / 4 / 10 / 25 files
- the relevance floor trims padded low-score hits
- packed chars never exceed `ASK_PACK_CHARS`

## Out of scope
- No model changes; Sonnet 4.6 remains the Ask writer, Nemotron the per-file reader.
- No stemming or synonym expansion (the structure-driven `expandQuery` stays as is).
- OCR and ingest budgets unchanged.
