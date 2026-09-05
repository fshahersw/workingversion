# Re-test the reading pipeline after the parser fix

Two runs, in order, then a written comparison.

## 1. Model bake-off, re-run with the real parser

Same synthetic harness as before: 16 sections, ~58,000 characters each (~940,000 total), one planted needle per section (deadline, dollar figure, holding, sanction, obligation, hearing date). Live section-digest prompt, `reasoning_effort: "none"`, 16-way parallel.

Difference from last time: facts are scored through the **application's** parser (`parseJsonBlock` / `stripJsonBlock` / `coerceFacts`) as it now stands, not a lenient benchmark parser. That is the number that changed.

Measured per model (Nemotron Lightning 3.5, Kimi K3):

- wall clock for all 16, median and slowest call
- needles found
- facts parsed by the app parser (expected: near-parity with needles now)
- fenced vs unfenced responses (should no longer matter)
- output tokens, invalid page anchors, unknown fact kinds coerced

## 2. Full 400-page end-to-end validation

Drive `/api/summarize` with the 400-page / ~1.47M-character document in all three modes:

- **Fast** — Nemotron, single pass, no sweep.
- **Standard** — Nemotron, dual pass cross-analysis, sweep.
- **Thorough** — Kimi K3 single pass, Opus sweep.

Per mode, record: wall clock, section count and call count, ledger fact count from the **map** pass specifically, whether both planted needles (ESI deadline p. 117, $412.5M fund p. 344) land with correct anchors, conflicts raised, coverage result, and any empty-fact sections.

Also confirm the fallback path: with the Fireworks key unavailable to the call, the run still completes on Claude.

## Output

One comparison table (bake-off) plus a per-mode results table for the 400-page run, and a short recommendation on whether the current per-mode engine defaults should stay as they are.

## Notes

No project source changes are part of this plan — it is validation only. Scripts live under `/tmp/bench`. If the run exposes a defect (empty map-pass ledgers, bad anchors, mis-coerced kinds), I will report it and propose the fix rather than silently patching.
