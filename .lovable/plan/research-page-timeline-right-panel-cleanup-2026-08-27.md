# Research page: timeline + right panel cleanup

## 1. Kill the scrollbar on the reasoning timeline
- Remove the internal `max-h-[46vh]` / `max-h-[42vh]` + `overflow-y-auto` wrappers in `AgentTimeline.tsx`. The timeline grows naturally inside the main chat scroll area, so there is never a nested scrollbar over the reasoning.
- Keep the timeline collapsed by default with the quiet text disclosure; expanded state just extends the message.

## 2. Reposition and restyle the timeline
- Add breathing room above the timeline (push it down from the user message) and tighten the gap below it before the answer.
- Cleaner, more modern treatment: a soft inset surface with a single hairline left rail, muted small-caps phase labels, subtle status dots (running = soft pulse, done = quiet check, no loud colors), tool names as light monospace-ish text separated by thin dots, counts as faint trailing numerals.
- No borders-on-borders, no pills, no heavy backgrounds.

## 3. Rebuild the source cards
- Flat rows instead of boxed cards: favicon/domain glyph, headline (2-line clamp), then one muted metadata line (domain · date · authority tier dot).
- Remove the inline expandable content wells that bloat the panel; snippet shows as 2 lines max, full text opens in the reader.
- Hover reveals the actions (open, Ask AI) instead of showing them always.
- Numbered citation markers aligned left so they match `[n]` refs in the answer.

## 4. Make the right panel actually useful
Turn it from a flat source list into a working research rail with three stacked sections:
- **At a glance** — counts by source type (firm corpus / court + agency / press), date range covered, and a flag when nothing came from the internal corpus.
- **Authorities** — primary court/agency/docket sources first, grouped and ranked, since those are what a lawyer cites.
- **Supporting coverage** — press/secondary, collapsed by default.
Plus a filter row (All / Authorities / Corpus / Press) and jump-to-citation behavior: clicking a source highlights its `[n]` in the answer.

## Technical notes
Files touched: `src/components/chat/AgentTimeline.tsx`, `src/components/chat/SourcePanel.tsx`, `src/components/chat/ChatView.tsx` (spacing + panel wiring), `src/styles.css` (drop the now-unused scroll utility where no longer applied). Presentation only — no changes to orchestration, prompts, models, or SSE payloads.
