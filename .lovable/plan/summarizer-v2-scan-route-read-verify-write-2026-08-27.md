# Summarizer v2: Scan → Route → Read → Verify → Write

Today the summarizer does one thing to every page: cut the document into equal
52k-char slices, send them all to the model, merge whatever comes back. That is
parallel but blind — the model spends the same effort on a certificate of
service as on the operative order, and nothing checks the output against the
source. The fix is to make the parallelism *targeted* and to add a verification
step so accuracy stops depending on the reader model behaving.

## The five stages

```text
1. SCAN     cheap, local, no LLM   → page map, doc type, section boundaries
2. ROUTE    one small LLM call     → priority tiers + question list
3. READ     wide parallel fan-out  → digests, budget by tier
4. VERIFY   parallel, targeted     → every fact re-checked on its own page
5. WRITE    hierarchical reduce    → memo built only from verified facts
```

### 1. Scan (no model, milliseconds)
Build a page map before any token is spent: per page, character count, density,
detected heading, whether it is boilerplate (service lists, exhibit covers,
blank/scan pages), and which risk-lexicon terms it contains. Cut sections on
detected headings instead of fixed character counts, so an argument section is
never split mid-sentence across two workers.

### 2. Route (one fast call)
Send only the page map — headings, first line of each page, term hits — not the
full text. The model returns:
- a priority tier per section: `critical` / `normal` / `skim`
- a document type (order, complaint, contract, deposition, expert report…)
- 8–15 concrete questions this document must answer

This is the piece that makes the rest targeted: everything downstream is driven
by the tiers and the question list rather than by uniform slicing.

### 3. Read (parallel, budgeted by tier)
Same fan-out as today, but effort is no longer flat:
- `critical` sections → precise reader (Kimi K3), full extraction prompt, dual pass
- `normal` → fast reader (Nemotron), single pass
- `skim` → one-line summary only, no fact extraction

Each call also carries the routed question list, so readers know what to hunt
for instead of extracting generically. Explicit `[page N]` markers are injected
into the text so page anchors come from the input, not the model's counting.

### 4. Verify (the missing stage)
Every extracted fact currently goes straight into the memo on trust. Instead,
batch facts by page, and for each batch send only the cited page's raw text plus
the claims back to the fast model: *does this page support these claims, exactly
as stated?* Each fact comes back `confirmed` / `wrong page` / `unsupported`, with
a corrected page when the anchor drifted. This is fully parallel and cheap — it
is short input and yes/no output — and it kills the two known defects: page
drift and near-duplicate facts (dedupe with a fuzzy claim match over a ±2 page
window before verifying).

Unanswered routed questions trigger a second targeted sweep over the pages whose
term hits best match the question — replacing today's blind top-3 sweep.

### 5. Write
The writer receives verified facts only, grouped by question, with any
`unsupported` items surfaced separately as gaps rather than silently dropped.
Reduce stays hierarchical; coverage check runs against the routed questions
instead of against raw page numbers.

## What the user sees

The reasoning rail gains real structure instead of a generic progress log:
document type, section tiers, the question list, live per-question answered
state, verification counts (`142 facts · 138 confirmed · 3 re-anchored · 1
unsupported`), and gaps. Modes stay Fast / Standard / Thorough and control how
many tiers get the precise reader and whether verification is sampled or full.

## Why this is better

- **Targeted**: effort concentrates on the pages that matter; skim pages cost ~nothing.
- **Methodical**: a fixed question list defines "done", so coverage is measurable.
- **Accurate**: no claim reaches the memo without being checked against its page.
- **Systematic**: five named stages with typed outputs, each independently testable.
- **Still fast**: scan is free, route is one small call, and verify is short-input
  work at high concurrency — Standard mode should land near today's runtime
  despite the extra stage, because skim pages drop out of the read fan-out.

## Technical notes

- New: `src/lib/agents/doc-scan.ts` (pure, testable page map + heading sectioning),
  `src/lib/agents/router.server.ts` (route call), `src/lib/agents/verify.server.ts`
  (fact verification + fuzzy dedupe).
- `summarizer.server.ts` becomes the orchestrator over those stages; existing
  prompt/parse/reduce helpers are reused, not rewritten.
- `summarizer-config.ts` gains tier budgets, verification batch size, and a
  `verificationMode` per summarize mode.
- New SSE events: `scan`, `route`, `verify`, `gaps`; existing events unchanged so
  the current UI keeps working while the new rail panels are added.
- Fireworks/Claude fallback behavior and the `fireworksEnabled()` guard are
  unchanged; the router and verifier both run on the fast model.
