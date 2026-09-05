# Reading-model bake-off: Nemotron Lightning vs Kimi K3

I ran both models through the live section-digest prompt on synthetic 58,000-character sections (14 pages each), one planted "needle" per section — a deadline, dollar figure, holding, sanction, obligation or hearing date buried in filler.

## Results

16 sections read in parallel (~940,000 characters, one pass):

| | Nemotron Lightning 3.5 | Kimi K3 |
|---|---|---|
| Wall clock, 16 sections | **6.8s** | 18.4s |
| Median call | **2.3s** | 10.4s |
| Needles found (with a correct parser) | 15/16 | **16/16** |
| Emitted the fenced ```json block | 5/16 | **16/16** |
| Facts our current code actually parses | **3/16** | **16/16** |
| Output tokens | 13,659 | 7,847 |
| Bad page anchors | 0 | 0 |

Smaller 8-section run agreed: Nemotron 5.8s wall / 6 of 8 parsed, Kimi 13.1s / 8 of 8.

## The important finding: we are silently losing facts today

Nemotron is fast and it *does* find the needles — but it usually returns the fact JSON as bare text instead of inside a ```json fence. `parseJsonBlock` in `summarizer.server.ts` only handles fenced blocks, with a `lastIndexOf("{")` fallback that lands inside the facts array and fails to parse.

Net effect right now: **roughly 80% of section fact ledgers come back empty**, even though the model extracted them correctly. That matches the 400-page test run, where every section reported `facts: 0`. The needles were only recovered later by the sweep pass.

A second, quieter bug: `stripJsonBlock` only strips fenced blocks, so unfenced JSON stays glued to the digest text that gets handed to the writer.

Nemotron also invents fact kinds outside the allowed list (e.g. `"kind":"fact"`), and over-extracts filler sentences as facts.

## Plan

### 1. Fix fact extraction (this is the whole win)

- Rewrite `parseJsonBlock` to scan for the last balanced `{...}` object containing a `"facts"` key, fenced or not, instead of the `lastIndexOf("{")` guess.
- Rewrite `stripJsonBlock` to remove that same object from the digest, fenced or not.
- In `coerceFacts`, snap unknown `kind` values to the nearest allowed kind (default `holding`) rather than dropping the fact.

Expected: section fact recall goes from 3/16 to 15/16 with no speed cost.

### 2. Keep Nemotron as the default reader, add Kimi K3 for Thorough

- Fast and Standard: Nemotron Lightning, concurrency 16 — it is 2.7x faster and, once parsed, essentially as accurate.
- Thorough: Kimi K3, concurrency 12 — perfect format compliance, tighter and less noisy fact lists, still 3x faster than the Claude path it replaced.
- Standard keeps dual-pass cross-analysis on Nemotron; Thorough runs a single Kimi pass plus the existing Opus sweep (Kimi's precision makes a second pass redundant).

### 3. Nudge the prompt

Add one line to the digest prompt requiring the fenced block explicitly ("the JSON MUST be inside a ```json fence"). Cheap insurance — but the parser fix, not the prompt, is what we rely on.

### 4. Re-validate

Re-run the 400-page document end to end and confirm section events report non-zero facts, both planted needles land in the ledger from the map pass (not just the sweep), and coverage reports them as covered.

## Files to touch

- `src/lib/agents/summarizer.server.ts` — parser, strip, kind coercion, per-mode engine selection.
- `src/lib/agents/fireworks.server.ts` — add the Kimi K3 model constant.
- `src/lib/summarizer-config.ts` — per-engine concurrency, dual-pass rule per mode.
- `src/lib/agents/prompts.ts` — one-line fence requirement.
