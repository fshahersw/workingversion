# Fix Deposition Analysis Review Findings

## Verdict on the push
Architecture is sound: quote-verification against real transcript lines, race-free window merging, clean isolation from Doc Search, 16/16 parsing tests pass. Four fixes needed — two are blocking build errors.

## Fixes

### 1. Type error — `DepositionAnalysisPane.tsx:273` (blocking)
The stats array literal infers `tab: string`; annotate it as `{ label: string; n: number; tab: AnalysisTab }[]` (or `as const` / satisfies) so it matches the prop type.

### 2. Type error + dedup bug — `deposition-analysis.ts` (blocking + correctness)
- `mergeDepAnalysis` calls `uniq()` for `contradictions`, but `DepContradiction` has no `quote` field — type error and wrong dedup semantics.
- Rework dedup keys across the merge:
  - Findings (profile/admissions/impeachment/themes/objections): dedupe on `cite + normalizeQuote(quote)` instead of `title + quote` — the synth/cross passes rephrase titles for the same testimony, and title+quote lets duplicates through.
  - Contradictions: dedicated dedupe on normalized `a.quote + b.quote` (order-insensitive) or `title + a.cite + b.cite`.
  - Exhibits: keep `name + cite` but compare normalized names case-insensitively.
  - Witnesses: dedupe on normalized `name` alone (fileName can vary in spelling across passes).

### 3. Remove the dead `mode: "digest"` route branch
`ask.ts` routes `"digest"` into `writeDepositionAnalysis`, but no caller sends it. Either remove `"digest"` from the mode union/route or rename to the intended pass. Recommend removal — it would silently produce deposition JSON for any future caller expecting the old digest behavior.

### 4. Test hardening
- Add a fixture to `transcript.test.ts` for a page with >28 lines under one Q/A and a short page followed by a low page number, documenting `isPageHeader` heuristic behavior.
- Add a `mergeDepAnalysis` test asserting that a re-titled duplicate quote from a second pass is deduped.

## Deliberately not changing
- Single full-text "delta" instead of token streaming — works fine; renaming not worth churn now.
- `sampleDigestBlocks` / `quoteInTranscript` unused exports — harmless; leave unless you want cleanup.

## Files touched
- `src/components/summarize/DepositionAnalysisPane.tsx`
- `src/lib/pile/deposition-analysis.ts`
- `src/lib/pile/deposition-analysis.test.ts`
- `src/lib/pile/transcript.test.ts`
- `src/routes/api/pile/ask.ts`

## Acceptance criteria
- [ ] Typecheck passes with zero errors.
- [ ] All existing pile tests still pass, plus the two new test cases.
- [ ] Running analyze on a multi-window transcript shows no duplicated findings after the synth pass.
- [ ] Doc Search tab behavior unchanged.
