# Plan: Replace the clunky native scrollbar in the chat

## What it is

The ▲ / pill / ▼ widget is not a component we built — it's your OS's **native scrollbar** (Windows classic style, with arrow buttons) rendering on the chat column's scroll container (`ChatView`'s `overflow-y-auto` div). It only appears on systems with "always show scrollbars"; Mac/overlay scrollbars never show it, which is why it doesn't reproduce in headless screenshots.

## Fix (UI-only, `src/styles.css` + `ChatView.tsx`)

- Add a slim, premium app scrollbar utility (alongside the existing `wr-source-scroll`): thin (~8px), transparent track, subtle navy-tinted rounded thumb that darkens on hover — **no arrow buttons**, matching the Sources panel's in-card scroll styling already in `src/styles.css`.
- Apply it to the main chat scroll container in `ChatView.tsx` and the reasoning-timeline scroll areas in `AgentTimeline.tsx` (the other user-facing vertical scrollers on `/research`).
- Optional global fallback: set `scrollbar-width: thin` + matching `::-webkit-scrollbar` rules on the app shell so any other scrollable panel (matters table, summarize, home feed) gets the same quiet treatment instead of the OS default.

## Verification

Typecheck, then screenshot `/research` with a long conversation and the sources panel scrolling to confirm the slim scrollbar renders and no layout shift occurs.
