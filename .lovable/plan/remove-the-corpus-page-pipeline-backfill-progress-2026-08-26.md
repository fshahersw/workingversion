# Remove the Corpus page (pipeline backfill progress)

The Corpus page (`/corpus`) is a read-only dashboard showing per-matter pipeline stage progress and recent ingest runs. It's fully self-contained — nothing else links to it except the sidebar nav item. Removing it does not touch the corpus database, RAG retrieval, agent tools, or the running embeddings.

## Changes

1. **Delete `src/routes/corpus.tsx`** — the route file (renders `CorpusHealth` inside `AppShell`). The generated route tree (`src/routeTree.gen.ts`) regenerates automatically; it is never edited by hand.
2. **Delete `src/components/corpus/CorpusHealth.tsx`** — the page component; used only by the corpus route. Removes the now-empty `src/components/corpus/` directory.
3. **Edit `src/components/app-shell.tsx`** — remove the `{ icon: Activity, label: "Corpus", to: "/corpus" }` nav item (line 33) and the `Activity` icon import if it becomes unused.

## What stays untouched

- `src/lib/corpus.server.ts`, `src/lib/rag.server.ts`, `src/lib/sidecar.server.ts`, `src/lib/agents/tools.server.ts` — backend corpus/RAG code used by the research agents and Matters pages.
- `src/lib/workspace.ts` query options (`mattersQueryOptions`, `pipelineRunsQueryOptions`, `formatCorpusDate`) — shared helpers; `mattersQueryOptions` is used elsewhere, and leaving the others costs nothing.
- Matters pages, Research page, and the in-flight embedding job — unaffected.

## Verification

- `bunx tsgo --noEmit -p tsconfig.json` passes (catches any dangling import).
- Load the app: sidebar no longer shows Corpus; Home, Matters, and Research render normally; navigating to `/corpus` no longer resolves (router 404).
