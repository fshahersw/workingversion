# View Source → PDF, No Writer-Phase Shimmer, Smooth Stream-Tracking Scroll

Three targeted UX fixes on the Research page. No backend contract changes — one small URL-priority change in the agent server code, everything else is frontend.

## 1. "View source" opens the actual PDF for corpus results

Today the button already opens in a new tab, but the URL attached to corpus sources prefers CourtListener — and one path (`listDocuments`) falls back to a stale Supabase-storage URL that doesn't point at the real files.

**Change the link priority for any source backed by a stored document:**
- Web search results: unchanged — open the web page URL in a new tab.
- Corpus/RAG results: open a presigned S3 URL for the actual stored PDF (1-hour expiry) in a new tab. CourtListener URL becomes the fallback only when no stored file exists (e.g. metadata-only rows).

Edits:
- `src/lib/rag.server.ts` — `hitPdfUrl`: try `presignS3Get(MATTERS_BUCKET, s3Key)` first, fall back to `courtlistenerUrl`.
- `src/lib/agents/tools.server.ts` — `listDocuments` (line ~355): replace `doc.courtlistenerUrl || corpusFileUrl(doc.s3Key)` with the same S3-first logic (reuse `hitPdfUrl`). The old `corpusFileUrl` points at the retired Supabase bucket and produces dead links.

Docket-ledger sources that have no PDF keep their current behavior.

## 2. No timeline/shimmer while the writer streams

Today the timeline collapses on `writer_start`, but the collapse is only driven by `collapseTimeline` — any late round/agent event or an expanded "view reasoning" pill can still show shimmering agent names and the "Thinking through the next step…" phrase while the answer is streaming.

Edits (frontend only):
- `src/components/chat/ChatView.tsx` — render `<AgentTimeline collapsed>` whenever `msg.status` is `"writing"` or `"done"`, regardless of late events.
- `src/components/chat/AgentTimeline.tsx` — accept an optional `settled` prop: when set, the "Thinking through the next step…" shimmer row and per-agent name shimmer never render, even inside the expanded "view reasoning" pill.
- "Planning research…" stays gated to the initial thinking state (already correct).

## 3. Smooth scroll that tracks the writer's output speed

Today the auto-follow scroll jumps instantly (`behavior: "auto"`) on every token flush, which reads as stuttery.

Edit `src/components/chat/ChatView.tsx`:
- While the last message is `status === "writing"` and the user is pinned near the bottom (within ~120px), run a lightweight `requestAnimationFrame` chase loop: each frame eases `scrollTop` a fraction (~20%, min 1px) toward `scrollHeight`, so the page glides down continuously at the same pace the answer renders.
- If the user scrolls up (unpins), the loop pauses immediately; scrolling back to the bottom resumes it.
- On `done`, the loop stops after settling at the true bottom. No change to the instant jump when a new user message is sent.

## Verification

- Run one research query in the preview: confirm corpus source cards open the PDF in a new tab, web cards open the web page, no shimmer appears once the answer starts streaming, and the page glides smoothly with the output.
- Confirm build passes.
