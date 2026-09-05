# Faster, cheaper document summarization

## Goal

Keep the current page-cited memo quality, but cut wall-clock time and API spend for 100-1,000-page filings.

## Current method (verified)

- Browser extracts text page-by-page (`pdfjs-dist`, `mammoth`) and sends text + page anchors to the server.
- `src/lib/agents/summarizer.server.ts` slices text into ~32k-character sections aligned to page boundaries.
- Each section is digested in parallel by `claude-sonnet-5` (max 4 concurrent calls).
- If the digests exceed ~60k characters they are recursively consolidated by Sonnet until they fit.
- `claude-opus-4-8` streams the final memo from the consolidated digests.

So it is already parallel and loop-based, but it always pays the full map/reduce/Opus cost even for short documents.

## Proposed changes

```text
short document (fits in one call)
  → single Sonnet pass, no map/reduce, no Opus

medium document
  → fewer, larger Sonnet sections
  → single reduce level (or none)
  → Opus final only when needed

very long document
  → larger sections + higher concurrency
  → same recursive reduce, but fewer passes
```

### 1. Adaptive single-pass for short documents

If the extracted text fits safely in one model context window, skip the entire map/reduce pipeline and ask Sonnet (or Opus if the user selected "thorough") for the final memo directly.

- Add a cheap token/character budget check before sectioning.
- Use Sonnet 5 as the default single-pass writer for short docs; keep Opus 4.8 for the "thorough" mode or docs above the budget.
- Preserve the same page-citation contract in the prompt.

### 2. Larger, more efficient sections

`SECTION_CHARS` is currently 32,000 characters. Sonnet 5 has a large context window, so raising this reduces the number of parallel section calls and the number of reduce passes.

- Raise target section size to ~48,000-56,000 characters.
- Raise `REDUCE_LIMIT` to ~120,000 characters so fewer digests need consolidation.
- Keep page-boundary alignment so citations stay accurate.

### 3. Dynamic concurrency and token budgets

- Raise max parallel section digests from 4 to 6-8, with bounded backoff if Anthropic returns 429.
- Size `max_tokens` per section based on section length instead of always allocating 4,000 tokens (small pages should not pay for 4k output).
- Use a smaller output cap for the optional "fast" mode.

### 4. Optional "fast summary" mode

Add a UI toggle or pre-run choice:

- **Standard** (default): current quality pipeline, optimized by the changes above.
- **Fast**: tighter section/output sizes, single Sonnet pass where possible, slightly denser but shorter memo. Best for a quick first read.
- **Thorough**: full pipeline, Opus final, larger output cap. Best for dispositive motions, orders, or expert reports.

### 5. Pre-run cost/time estimate

Before the user starts a run, estimate:

- number of sections
- expected LLM calls
- approximate duration
- rough cost tier (low / medium / high)

This uses the same character budget math as the pipeline and is shown in the drop-zone header.

### 6. Skip low-value boilerplate before the LLM

- Collapse consecutive empty pages (already detected, but currently only counted).
- Strip or dedupe repeated header/footer text that appears on many pages.
- Optionally tag certificate-of-service / signature-only pages as low-value so the section builder can deprioritize them.

This reduces input tokens without changing the substantive text.

## Why not RAG for the general summarizer

RAG selects the "most relevant" chunks, which is great for question-answering but can miss facts a full summary must capture (e.g., a single deadline on page 412). The current map/reduce approach reads the whole document; the improvement is to make it cheaper, not replace it with retrieval. RAG can be added later as a separate "Ask this document" feature.

## Files to touch

- `src/lib/agents/summarizer.server.ts` — adaptive strategy, larger sections, dynamic concurrency, token budgets.
- `src/lib/agents/prompts.ts` — single-pass writer prompt and tightened fast-mode prompts.
- `src/lib/extract-text.ts` — boilerplate/empty-page cleanup (optional, low-risk).
- `src/lib/use-summarizer.ts` — mode selection, cost estimate, pass mode to the server.
- `src/components/summarize/SummarizeView.tsx` / `DropPanel.tsx` — mode toggle and estimate display.

## Validation

- Test a 5-10 page filing: should complete in one Sonnet call.
- Test a 200-page brief: should use fewer sections and reduce levels than today.
- Test a 1,000-page transcript: should still complete, with visible speedup.
- Compare output quality side-by-side for the same file in standard vs fast vs thorough modes.
