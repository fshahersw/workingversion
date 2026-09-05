# Simplify Summarize Speed Selector

Remove the Fast / Standard / Thorough mode selector from the Summarize drop panel and use a single default “medium” speed (Standard mode).

## What to change

1. Update `src/components/summarize/DropPanel.tsx`:
   - Remove the `MODES` array and the three mode-selection pill buttons.
   - Remove the `mode` and `onModeChange` props.
   - Keep the default behavior equivalent to the current **standard** mode.
   - Preserve the estimate text if useful, or simplify it to a plain duration estimate.

2. Update `src/components/summarize/SummarizeView.tsx`:
   - Drop local `mode` state and the `onModeChange` handler.
   - Hardcode `mode="standard"` when starting a summarization run.
   - Remove any remaining mode UI references.

3. Update `src/lib/use-summarizer.ts`:
   - Ensure the hook no longer expects an external mode toggle and defaults to standard.

## Out of scope

- No backend or summarization algorithm changes.
- No changes to the pipeline, models, or page limits.

## Validation

- TypeScript typecheck passes.
- `/summarize` renders with a single, clean upload card and no speed pills.