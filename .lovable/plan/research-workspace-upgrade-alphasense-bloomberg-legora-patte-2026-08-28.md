# Research workspace upgrade (AlphaSense / Bloomberg / Legora patterns)

Turn the Research page from "chat + source list" into a working research desk: the
answer becomes a work product you can act on, every citation opens the underlying
document, and recurring questions become monitored topics.

## 1. Answer workspace actions

A quiet action bar on each finished assistant answer:

- **Copy with citations** — markdown or plain text, footnoted source list appended.
- **Export memo** — DOCX and Markdown download, firm-branded header, question,
  answer, numbered authorities with dates/courts.
- **Save to matter** — attach the answer + its sources to a matter; it then appears
  on the matter page under a "Research" section.
- **Pin passage** — select text in an answer (or a source row) and pin it to a
  right-rail clipboard for the session; pinned items export together as a memo.
- Per-answer **Share link** is out of scope for now (no external sharing surface).

## 2. Citation-linked reading pane

Clicking an inline `[n]` citation or a source row opens a reader over the right
panel instead of leaving the page:

- Corpus documents: PDF rendered from the existing signed-URL path, jumped to the
  cited page, with the cited passage highlighted.
- Docket entries: entry header, filed date, parties, linked child documents.
- Web sources: extracted readable text with the cited snippet highlighted, plus
  an "Open original" link.
- Reader is a stacked overlay with back navigation, so citation → doc → related
  doc keeps history. Escape or back returns to the source list.

## 3. Watchlists and follow-ups

- **Save this question as a watch** from the answer bar: stores the question,
  matter scope, and a fingerprint of the sources already seen.
- A scheduled backend job re-runs watches (reusing the existing intel/docket
  collection paths) and records only *new* matching filings, orders, and news.
- **Alerts** surface in two places: a badge on the Research sidebar entry, and a
  Watchlist card on Home listing "3 new filings since Tuesday" per watch.
- Opening an alert starts a new research turn pre-seeded with the delta.

## 4. Additional patterns worth adding (my suggestions)

- **Scope bar above the composer** — matter, court, date range, source class
  (corpus / courts / agencies / web). Passed into retrieval so the agent honors
  it, with the active scope shown as removable chips. This is the single biggest
  quality lever and mirrors AlphaSense's filter rail.
- **Compare mode** — pick 2–4 sources or matters and get a side-by-side
  synthesized table (holding, posture, key dates, outcome). Bloomberg/Legora both
  lean on comparison tables heavily.
- **Entity hovercards** — judges, firms, courts, and matters in an answer get a
  hover summary pulled from the corpus (cases before that judge, related MDLs).
- **Answer confidence + coverage strip** — a one-line, non-chatty indicator of how
  much of the answer is corpus-backed vs. web-backed, with a click-through to the
  uncited-but-related sources.
- **Prompt library** — saved firm prompts ("bellwether posture for MDL X",
  "removal timeline check") available from the composer, per-user and firm-wide.

## Build order

1. Scope bar + answer action bar (copy, export, save to matter) — highest value,
   lowest risk.
2. Citation-linked reading pane, including pinning from within the reader.
3. Watchlists, alert storage, and Home watchlist card.
4. Compare mode, hovercards, prompt library.

## Technical notes

- Persistence follows the existing pattern in `src/lib/research-history.ts`:
  browser Supabase client under RLS, user-scoped rows. New tables:
  `research_saved_answers`, `research_pins`, `research_watches`,
  `research_watch_hits`, `research_prompts` — each with owner-scoped RLS policies
  and explicit `GRANT`s.
- Reader pane reuses `getDocumentViewUrl` / `getEntryDocuments` from
  `src/lib/workspace.functions.ts`; web-source text reuses the Firecrawl-backed
  extraction already used by the intel collector, cached per URL.
- Scope is threaded through `streamOrchestrate` into the router/subagent prompts
  and into corpus retrieval filters in `src/lib/rag.server.ts`; no change to model
  choice, token budgets, or writer output style.
- Watch re-runs execute in the existing external ETL/worker path, not in the
  request cycle; the app only reads recorded hits.
- DOCX export is generated client-side from the stored answer + sources so no new
  server surface is needed.
- UI is composed from existing components (`ChatView`, `SourcePanel`,
  `AgentTimeline`) and current design tokens; no new visual language.
