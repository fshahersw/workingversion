# Summarizer: quality, nuance, and needle-in-a-haystack upgrades

The pipeline today is: browser extraction → 52k-char sections → parallel Sonnet digests → recursive reduce → streamed final memo. That is fast, but a single flat digest pass loses small, high-value details (one-line dates, dollar figures, a buried admission) and produces generic prose on long records.

Five upgrades, ordered by impact. Each is independent — approve all or a subset.

## 1. Structured fact ledger (biggest nuance win)

Each section pass returns two things instead of one blob:
- a short prose digest (as today), and
- a JSON list of atomic facts: `{claim, page, kind, actors, date, amount, quote}` where `kind` is one of date, amount, party, holding, deadline, obligation, risk, contradiction.

Facts are never summarized away — they are merged, deduped, and passed to the writer verbatim alongside the digests. The writer must cite from the ledger. This is what makes a $2.4M indemnity cap on page 612 survive to the memo.

Side benefit: the ledger renders as a filterable "Key facts" table under the memo, with page jump links.

## 2. Overlap + heading-aware sectioning

Fixed 52k slices cut clauses in half. Change to:
- ~2k character overlap between adjacent sections so nothing straddles a boundary,
- prefer to break on detected headings / numbered sections / page breaks rather than mid-sentence,
- carry a one-paragraph "story so far" from the previous section into the next prompt so digests know the context they sit in.

## 3. Targeted second pass (needle retrieval)

After the map pass, run a cheap retrieval sweep over the raw page text for the user's instructions plus a standard risk lexicon (indemnity, termination, exclusivity, penalty, waiver, arbitration, change of control, cap, deadline). Pull the matching pages and run one focused Sonnet pass over just those pages. Its output merges into the ledger before the writer runs. Cost: usually one to three extra calls; catches things the digest pass compressed away.

If the user typed instructions ("find every deadline"), those terms drive this sweep and get a dedicated section in the memo.

## 4. Contradiction and coverage checks

- During reduce, ask the model to flag conflicting facts (two different dates for the same event) and surface them as a "Conflicts / ambiguities" block instead of silently picking one.
- After the memo streams, verify every cited page number exists and every ledger fact of kind date/amount/deadline appears in the memo or in the key-facts table. Show a small coverage indicator in the reasoning rail.

## 5. Speed, without losing the above

- Cache section digests by content hash, so re-running with new instructions only re-runs the targeted pass and the writer.
- Skip digesting near-empty or boilerplate pages (signature blocks, exhibit covers, repeated headers) — detected by cross-page repetition.
- Raise concurrency adaptively based on observed rate-limit headroom rather than a fixed 6-8.
- Scanned PDFs currently extract to nothing; detect low text yield per page and warn the user up front instead of producing an empty memo.

## Technical notes

- `src/lib/agents/prompts.ts`: new fact-extraction contract in the section prompt (prose + fenced JSON), a targeted-sweep prompt, and writer instructions to consume the ledger.
- `src/lib/agents/summarizer.server.ts`: overlap-aware `buildSections`, ledger merge/dedupe, targeted pass, conflict pass, coverage check; new SSE events `fact`, `sweep`, `conflict`, `coverage`.
- `src/lib/summarizer-config.ts`: overlap size, lexicon, sweep caps.
- `src/lib/use-summarizer.ts`: accumulate ledger/conflicts/coverage from the stream.
- `src/components/summarize/`: key-facts table + conflicts block in `SummaryPanel`, sweep/coverage steps in `ReasoningRail`.
- Digest cache keyed by SHA-256 of section text stored alongside `corpus.doc_summaries`.
- Fast mode keeps the ledger but skips the targeted and conflict passes; Thorough runs everything with Opus on the sweep.
