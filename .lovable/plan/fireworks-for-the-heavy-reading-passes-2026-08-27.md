# Fireworks for the heavy reading passes

## Idea

The expensive, slow part of the summarizer is not the memo — it's reading the document. Right now every section digest and every targeted sweep runs on Claude Sonnet 5 through Anthropic. Those calls are high-volume, highly parallel, and mostly mechanical extraction work: exactly what a cheap, fast, high-throughput hosted model is good at.

Move the **map/digest passes and the targeted sweep** to a Fireworks-hosted open model. Keep Claude Opus for the final memo (and the reduce/consolidation passes), so prose quality and citation discipline don't regress.

```text
extract (browser)
  → sections            → Fireworks   (many parallel, cheap)
  → targeted sweep      → Fireworks   (cheap)
  → reduce/consolidate  → Claude Sonnet (unchanged)
  → final memo          → Claude Opus  (unchanged)
```

## What changes

### 1. A second model provider

Add a small Fireworks client alongside the existing Anthropic client. Fireworks exposes an OpenAI-compatible chat API, so the client is a thin streaming `fetch` wrapper with the same shape the summarizer already uses (`model`, `system`, `messages`, `maxTokens`, abort signal, retry on 429/5xx).

Requires one new server secret: `FIREWORKS_API_KEY`.

### 2. Stage-level model routing

The summarizer already resolves models through a per-mode config object (`sectionModel`, `sweepModel`, `reduceModel`, `writerModel`). Extend each entry to carry a provider as well as a model id, and have the call sites dispatch on it. Nothing else in the pipeline changes — same prompts, same page anchors, same fact-ledger JSON contract, same SSE events.

Defaults per mode:

| Mode | Sections | Sweep | Reduce | Memo |
| --- | --- | --- | --- | --- |
| Fast | Fireworks | skipped | Claude Sonnet | Claude Sonnet |
| Standard | Fireworks | Fireworks | Claude Sonnet | Claude Opus |
| Thorough | Fireworks | Claude Opus | Claude Sonnet | Claude Opus |

If `FIREWORKS_API_KEY` is absent, every stage silently falls back to the current Claude models — no broken runs.

### 3. More parallelism

Fireworks tolerates far higher concurrency than the current 6–8 section workers, and each call is cheaper. Raise the section-digest concurrency (target 12–16) with the existing bounded-backoff retry, so a 1,000-page document finishes in a fraction of the current wall-clock.

### 4. Cross-analysis on the fact ledger

Since digest calls get much cheaper, run each section digest **twice in parallel** on the Fireworks model (different sampling) in Standard/Thorough, then merge the two fact lists:

- facts agreed by both passes → high confidence
- facts from only one pass → kept, marked lower confidence
- contradictory page/date/amount values for the same claim → routed into the existing conflict list

This is the "run them a bunch and cross-analyze" part, and it directly improves needle-in-a-haystack recall. Fast mode stays single-pass.

### 5. Model choice

Default to a strong long-context open model on Fireworks for digests — the exact id gets confirmed against the Fireworks catalog at build time and stored in one constant so it can be swapped without touching pipeline code.

## Files to touch

- `src/lib/agents/fireworks.server.ts` (new) — OpenAI-compatible streaming client.
- `src/lib/summarizer-config.ts` — provider-aware stage config, concurrency, dual-pass flag.
- `src/lib/agents/summarizer.server.ts` — dispatch per stage, dual-pass digest + merge.
- `src/lib/agents/prompts.ts` — minor prompt tightening for a non-Claude digest model.
- `src/routes/api/summarize.ts` — surface the digest provider/model in the `run` event.
- `src/components/summarize/ReasoningRail.tsx` — show which engine ran each pass.

## Validation

- 10-page filing: single pass, unchanged output.
- 200-page brief: digests on Fireworks, memo on Opus, compare fact ledger and citations against a Claude-only run of the same file.
- 1,000-page transcript: measure wall-clock and call counts before/after.
- Unset `FIREWORKS_API_KEY` and confirm the run still completes on Claude.

## Before I build

I need the `FIREWORKS_API_KEY` added as a secret, and confirmation of which Fireworks model you want as the digest engine (or I'll pick a long-context open model from their catalog and you can swap it).
