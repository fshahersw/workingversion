# Deposition Analysis: remove verification notices + layout polish

## Scope
UI-only changes to the Deposition Analysis tab (`src/components/summarize/DepositionAnalysisPane.tsx` and `DepositionView.tsx`). No changes to the analysis pipeline, verification logic, or `use-deposition` — findings are still verified and dropped server-side; we just stop announcing it.

## Changes

### 1. Remove verification-drop notices
- Delete the `analysis.dropped` banner in `DepositionAnalysisPane.tsx` ("N candidate findings were dropped because their quotes could not be verified verbatim…"). Verification still runs; the notice is simply not displayed.

### 2. Layout / UX polish (no functionality changes)
- **Analysis rail**: slightly wider (160px → 172px) with clearer group spacing; active tab keeps the navy fill, inactive tabs get a consistent hover state; running passes show a small spinner dot instead of the bare "…".
- **Content header**: keep the heading + witness role, add a subtle pass-status line only while passes are running (already partially present — consolidated into one place).
- **Finding cards**: tighten vertical rhythm (consistent padding, quote block styling shared across Admissions / Impeachment / Themes), keep the value badge + tags + cite/copy row.
- **Insights strip**: keep the clickable stat tiles; equalize cell heights and add hover affordance.
- **Empty states**: friendlier copy ("No admissions extracted from this transcript yet.") centered with a muted icon instead of a bare left-aligned line.
- **Header bar (DepositionView)**: keep file label / MDL / page count, Re-run / Export / Clear buttons — unchanged behavior, minor spacing consistency with the rest of Discovery.

### 3. Verification
- Type-check + lint clean.
- Visual check in preview: upload a transcript (or existing sample), confirm no dropped-finding banner appears, tabs/cites/ask all still work.

## Not changing
- Analysis passes, quote verification, dedupe, graph, export memo, ask/retrieval — all untouched.
