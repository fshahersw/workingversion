# Plan: Cleaner source rail + auto-scroll to the new question

Three changes, all in `src/components/chat/SourcePanel.tsx` and `src/components/chat/ChatView.tsx`. No backend, prompt, retrieval, or model changes.

## 1. Strip the RAG passage text out of the source rail

Each source row becomes a compact reference entry only:

- Favicon (or document glyph for internal corpus), citation/title, host or authority, date, ref number.
- Remove the retrieved-chunk preview, the "Read passage" expansion, the full markdown passage body, and the inline quote-snippet block.
- Keep click-to-highlight behavior at the row level: clicking a citation in the answer still selects and scrolls to the matching row (accent bar + tinted background), it just no longer reveals passage text.
- Keep "Open" (external link) and "Ask AI" as the row actions.
- The "Related" cards drop the one-line context sentence too, leaving favicon + host + title.
- `SourceMarkdown`, `findBestSpan` usage, and the passage scroll refs get removed from this file.

## 2. Group sources by kind of source, not by tier

Replace the current Courts & agencies / Firm corpus / Supporting coverage buckets with jurisdiction- and channel-based groups, derived from each source's type, authority, host, and citation string:

1. **Firm corpus** — matters, docket entries, filed documents (internal).
2. **Federal courts** — district/circuit/Supreme Court and JPML citations (e.g. `N.D. Cal.`, `9th Cir.`, `MDL`, `F. Supp.`, `.uscourts.gov`, CourtListener).
3. **State courts** — state reporter and state court citations/hosts.
4. **Statutes & regulations** — U.S.C., C.F.R., Federal Register, legislature hosts.
5. **Agencies** — `.gov` agency sources that are not courts.
6. **Web research** — general web-search results.
7. **Press** — news sources.

Only non-empty groups render, in that order, each with a small uppercase label and a count. Sources fall back to Web research when nothing matches.

## 3. Auto-scroll to the new question on submit

Today the chat jumps to the very bottom, so a new question can sit mid-screen under the tail of the previous answer. Instead:

- When a new user message mounts (Enter, send button, or a suggested follow-up chip), scroll so that user message sits at the top of the visible chat area.
- Add a bottom spacer sized to the scroll viewport so the newest turn can always reach the top even before the answer renders.
- Streaming auto-follow stays as-is: it only follows when the user is already pinned near the bottom, so the top-anchored view is not yanked away.

## Verification

Typecheck, then load `/research` in Playwright: run one query, confirm no passage text in the rail and that groups render by jurisdiction; then submit a second query and confirm it snaps to the top of the view.
