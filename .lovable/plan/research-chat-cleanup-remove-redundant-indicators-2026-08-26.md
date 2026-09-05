# Research Chat Cleanup: Remove Redundant Indicators

Four small removals, all frontend. No backend, prompt, or behavior changes beyond what's listed.

## 1. Remove the "Working… round N" spinner line
`src/components/chat/ChatView.tsx` (lines 258–267) — delete the `lastBusy` block that renders the spinning loader with "Working… round N" / "Working…". Also remove the now-unused `lastBusy` and `lastRoundCount` memos. The reasoning timeline already communicates progress, so nothing replaces it.

## 2. Remove the blinking cursor during writer streaming
- `src/components/chat/AnswerMarkdown.tsx` — stop applying the `wr-streaming` class (the `streaming` prop stays; it still drives smooth text reveal).
- `src/styles.css` — delete the `.wr-streaming > *:last-child::after` caret rule and its `wr-caret` keyframes (lines ~130–145). No other element uses them.

## 3. Remove the disclaimer line under every finished answer
`src/components/chat/ChatView.tsx` (lines 634–642) — delete the `showDisclaimer` block ("Research only — not legal advice. Verify filings and citations against the original sources before relying on them.") and remove the `showDisclaimer` prop from `AssistantMessage` and its call site (line 254). The separate "Coverage check" box is untouched.

## 4. Remove the "Jump to latest" button
`src/components/chat/ChatView.tsx` (lines 289–294) — delete the floating button. Remove the now-unused `ArrowDown` import.

## 5. Corpus source links — keep as-is
Confirmed: source cards for corpus/RAG results keep navigating to the stored PDF via the presigned S3 link (implemented previously); web results keep their web URLs. No change.

## Verification
- Typecheck/build passes.
- Visual check in preview: no "Working…" line, no blinking cursor while the answer streams, no disclaimer under answers, no "Jump to latest" pill; smooth chase-scroll still works.
