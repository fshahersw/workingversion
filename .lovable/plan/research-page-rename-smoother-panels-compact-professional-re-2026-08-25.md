# Research page: rename, smoother panels, compact professional restyle

Three workstreams: rename `/conversations` to `/research`, make the split-panel drag feel fluid, and restyle the research page toward the compact, law-professional look in your screenshots — including a working matter-scope chip in the composer.

## 1. Rename page + path: Conversations → Research

- Rename `src/routes/conversations.tsx` → `src/routes/research.tsx`; update `createFileRoute("/research")` and rename the component to `ResearchPage`. Add a `head()` with a unique title ("Research — Seeger Weiss") since the route currently has none.
- Replace the old file with a thin redirect route so `/conversations` keeps working: `beforeLoad` throws `redirect({ to: "/research" })`. The router plugin regenerates `src/routeTree.gen.ts` automatically — no manual edits there.
- Update the two link sites: `src/components/app-shell.tsx` nav item becomes `{ icon: Search, label: "Research", to: "/research" }`, and `src/components/home/HomeDashboard.tsx` navigates to `/research`. The session-storage handoff keys (`sw:initial-prompt`, `sw:prefill-prompt`) stay unchanged, so Quick Start tiles keep working.
- Sidebar active-state logic already works via `pathname.startsWith`, no other changes needed.

## 2. Buttery-smooth left/right panel dragging

Current jank cause: every pointermove sets React state (`leftPct`), re-rendering the whole chat tree per frame, while framer-motion `layout` animations on `AssistantMessage` and `SourceCard` run layout measurement against a continuously resizing container.

Fix in `src/components/chat/ChatView.tsx` + `SourcePanel.tsx`:
- During drag, update a CSS variable (`--split-pct`) **imperatively** on the split container inside the existing `requestAnimationFrame` throttle — zero React re-renders while dragging. Column widths read `var(--split-pct)`; final value is committed to state + localStorage once, on pointerup.
- Suspend layout animations during drag: pass `dragging` down and set `layout={false}` on `AssistantMessage` and `SourceCard` motion elements while active (they re-enable on release).
- Replace the non-reactive `window.innerWidth >= 1024` render check with CSS (`lg:` classes), and add `touch-action: none` + a wider invisible hit area on the separator handle, plus `select-none`/`cursor-col-resize` on the document while dragging.

## 3. Compact, less "bubbly", law-professional restyle

Guided by your screenshots (image-10/11/13): tighter density, smaller radii, serif headline.

**Composer (hero + in-chat, shared look):**
- Container `rounded-2xl` → `rounded-lg` (~10px), subtler shadow.
- Footer toolbar row separated by a top border, like the screenshots: left side holds the new **Matters chip** (below) and the mic button; right side holds the send button (`rounded-md`, navy).
- Follow-up chips `rounded-full` → `rounded-md`; user message bubble `rounded-2xl` → `rounded-lg` with a small corner accent.

**Landing/hero state (`src/routes/research.tsx`):**
- Add a serif display face (Source Serif 4, via Google Fonts `<link>` in `__root.tsx` + `--font-display` token in `src/styles.css`) used only for the hero headline. New headline: "What would you like to research?" with the existing subcopy tightened.
- Suggestion tiles: `rounded-xl` → `rounded-lg`, flatter hover (no `-translate-y`), title-first layout like the screenshots' "Suggested research" cards.
- Source panel cards: `rounded-lg` → `rounded-md` for a crisper register.

## 4. Matter chip that actually scopes the research

Per your choice, this wires through to the in-house agent backend (additive; SSE contract unchanged):

- **UI**: a `Matters ⌄` chip in the composer footer (Briefcase icon, label = "All matters" or the selected matter's short name). Opens a popover listing live matters from `mattersQueryOptions` (name, MDL badge, docket number, doc counts) with a search field — a compact variant of `MatterSelector`. Selecting sets the scope; the chip shows the matter with an × to clear.
- **Client plumbing**: `ResearchPage`/`ChatView` hold `matterScope` state; `use-chat.ts send()` and `streamOrchestrate` accept an optional `matter` (`{ matter_id, short_name, case_name }`) and include `matter_id` in the POST body.
- **Backend**: `src/routes/api/orchestrate.ts` parses `matter_id` + matter label and passes them into `runOrchestration`; `src/lib/agents/orchestrator.server.ts` adds the scope to the router/writer context ("The user is working in matter: Apple Smartphone MDL (2:21-cv-…)") and supplies it as the **default `matter_id` filter** for the `search_docket_text` / `list_documents` / hybrid-RAG tools (the RAG layer already accepts `filter_matter` — `src/lib/rag.server.ts:167`). The agent can still search globally if the question clearly leaves the matter's scope.
- A subtle scope indicator appears above the composer while a matter is selected ("Scoped to Apple Smartphone MDL · Clear").

## Files touched

- `src/routes/research.tsx` (renamed from `conversations.tsx`), `src/routes/conversations.tsx` (redirect), `src/components/app-shell.tsx`, `src/components/home/HomeDashboard.tsx`
- `src/components/chat/ChatView.tsx` (drag + composer + scope), `src/components/chat/SourcePanel.tsx` (layout-anim suspension, radii)
- `src/components/matters/MatterScopePicker.tsx` (new compact popover, reusing `mattersQueryOptions`)
- `src/lib/orchestrate.ts`, `src/lib/use-chat.ts`, `src/routes/api/orchestrate.ts`, `src/lib/agents/orchestrator.server.ts` (matter scoping)
- `src/styles.css`, `src/routes/__root.tsx` (serif display token + font link)

## Verification

- `/conversations` redirects to `/research`; sidebar nav + Home Quick Start tiles land on `/research`; deep-link/refresh works.
- Drag the separator at desktop width: no dropped frames, no source-card reflow flicker, split persists after reload.
- Select a matter in the composer, ask a docket question, confirm the answer cites documents from that matter only; clear the chip and confirm global search resumes.
- Typecheck/build clean; preview checked at desktop + mobile widths.
