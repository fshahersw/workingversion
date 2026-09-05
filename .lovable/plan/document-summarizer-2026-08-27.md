# Document Summarizer

A drag-and-drop workspace that turns long filings (up to ~1,000 pages) into a clean, cited summary. Left side: the drop zone that expands into the finished summary. Right side: the live reasoning loop — pass by pass — until the summary lands.

## Placement

You weren't sure, so the recommendation: a new **Summarize** tab in the sidebar, ordered Home → Matters → Research → Summarize. It's a distinct job from Research (one document in, one memo out), it needs the full width of the screen, and a matter can be attached optionally from a picker at the top so the summary files itself under the right matter.

## The screen

```text
┌──────────────────────────────┬──────────────────────────┐
│  DROP ZONE / SUMMARY         │  REASONING               │
│                              │                          │
│  drop PDF / DOCX / TXT       │  ▸ Reading  412 pages    │
│   ↓ (expands after upload)   │  ▸ Pass 1 · 18 sections  │
│                              │    "Sections 1-6 cover…" │
│  Summary of …                │  ▸ Pass 2 · consolidate  │
│  Matter: … · 412 pp          │  ▸ Drafting summary      │
│  ── streamed markdown ──     │  ✓ Done · 3m 04s         │
│  bullets, key facts, [p. 88] │                          │
└──────────────────────────────┴──────────────────────────┘
```

- Drop zone accepts multiple files at once; each shows its own parse/page progress.
- As soon as text is extracted the left panel expands into the document view and the summary streams in place.
- Page-anchored references (`[p. 88]`) are clickable and scroll/open the source PDF at that page.
- Right rail reuses the existing reasoning-timeline styling from Research, so it feels like the same product.

## How 1,000 pages is handled

1. **Extract in the browser.** `pdfjs-dist` (already a dependency) runs in a web worker and pulls per-page text with page numbers; DOCX via `mammoth`, TXT read directly. This keeps huge files off the server and gives real progress ("page 412 of 980"). Scanned/image-only pages are detected and reported rather than silently producing an empty summary.
2. **Upload the original** to the matters bucket via the existing presigned-PUT path, so the PDF can be reopened later.
3. **Map–reduce with Claude.** The page text is split into ~30–40k-character sections on natural boundaries. Sonnet summarizes sections in parallel (bounded concurrency), each digest keeping page anchors. If the digests are still too large, they're consolidated a level at a time until they fit.
4. **Final memo** written by Opus, streamed token-by-token into the left panel: what the document is, key facts, holdings/conclusions, notable numbers and quotes, dates, and open questions — with page cites throughout.
5. Every stage emits an SSE event, which is what the right panel renders.

## Saving

Summaries persist so you can revisit them:

- New `corpus.doc_summaries` table (matter link optional, title, page count, model, markdown summary, section digests, source object key, owner, timestamps) plus a service-only bridge view and grants, following the existing corpus SQL conventions.
- A "Recent summaries" list at the top of the tab reopens any past summary instantly, including its source PDF.

## Technical notes

- New streaming route `src/routes/api/summarize.ts` (SSE, same event vocabulary style as `/api/orchestrate`): `file`, `extract`, `plan`, `section`, `section_done`, `reduce`, `writer_start`, `delta`, `done`, `error`.
- Agent code in `src/lib/agents/summarizer.server.ts` with its prompts in `src/lib/agents/prompts.ts`, reusing `anthropic.server.ts` (`SUBAGENT_MODEL` for sections, `WRITER_MODEL` for the memo). Every call streams — no timers aborting long runs.
- New UI under `src/components/summarize/`: `SummarizeView`, `DropPanel`, `SummaryPanel`, `ReasoningRail`; route `src/routes/_authenticated/summarize.tsx` with its own head metadata.
- Text extraction never runs on the server, so Cloudflare Worker limits and Node-only PDF libraries are both avoided.
- Anthropic errors (rate limit, credits, overload) surface directly in the rail instead of a generic failure; partial section digests are kept so a retry resumes rather than restarting.
- New dependency: `mammoth` (DOCX → text). `pdfjs-dist` already present.
- Guardrails: hard cap at 1,000 pages / 50 MB per file with a clear message beyond it, and a cost/at-a-glance estimate shown before a very large run starts.
