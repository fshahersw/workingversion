# Ask: 12 results per query + Sonnet 5 writer

## Why only 8 results show today (verified)

The Ask path packs pages per file with `perFileCap`, which defaults to
`PER_FILE_ASK_PAGES = 8` in `src/lib/pile/pile-index.ts` (`packAskByFile`).
In `src/lib/use-pile.ts`, the per-file page budget is passed **only when the pile
has more than one file** (`fileCount > 1 ? budget.perFilePages : undefined`), so a
single-file Ask falls back to 8 — regardless of the 24-page `singlePack` budget.
That is the 8 you see in the hits list.

## Changes

### 1. Twelve hits per Ask, always

- `src/lib/pile/limits.ts`: add `ASK_MIN_HITS = 12` (floor for hits surfaced by
  an Ask) and raise `PER_FILE_ASK_PAGES` from 8 to 12.
- `src/lib/use-pile.ts`: always pass an explicit per-file cap to
  `packAskByFile` — `Math.max(budget.perFilePages, ASK_MIN_HITS)` for a single
  file, `budget.perFilePages` for multi-file piles (already >= 8, raised to 12
  minimum for 2-5 file tiers so each file still contributes real coverage).
- Single-file pile: cap becomes 12+, so the hit list shows 12 cited pages
  instead of 8. Multi-file piles are unaffected in shape — they already scale
  per file and pool well above 12.
- The relevance floor (`HIT_SCORE_FLOOR`) stays, so a document with only 4 real
  matches still returns 4 rather than 12 padded pages. Where the pile genuinely
  has fewer than 12 relevant pages, fewer are shown — that is intended.

### 2. Ask writer back on Bedrock Sonnet 5

- `src/lib/agents/bedrock-claude.server.ts`: `BEDROCK_PILE_WRITER_MODEL`
  becomes `us.anthropic.claude-sonnet-5` (the inference-profile id, same form as
  the research writer default) instead of `us.anthropic.claude-sonnet-4-6`.
- Keep it overridable via `BEDROCK_PILE_WRITER_MODEL` env so it can be flipped
  back without a code change.
- Both Ask call sites already route through the Anthropic invoke path
  (`streamBedrockClaude`) with `effort` set, which Sonnet 5 supports — no
  parameter changes needed. Sonnet 5 shares `max_tokens` between reasoning and
  the answer, so the single-file writer's `maxTokens` rises from 8000 to 12000
  and the cross-file writer is checked against the same floor, preventing an
  empty answer on long evidence packs.
- The 260k-char evidence ceiling (`ASK_PACK_CHARS`) is unchanged and still
  comfortably inside Sonnet 5's context.

### 3. Verification

- Update `src/lib/pile/client-search.test.ts` for the new 12-page cap and add a
  case asserting a single-file Ask packs 12 hits when 12+ relevant pages exist.
- Run the pile test suite and a typecheck.
- Live check: ask a question on a single-file pile and confirm 12 cited pages
  in the hits rail and that the writer banner reports Sonnet 5.

## Out of scope

- No change to Search-tab budgets (`perFileHits`) or IDF pruning.
- No change to the research writer (Opus 5) or the per-file reader (Nemotron).
