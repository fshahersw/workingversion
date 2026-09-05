# Plan: Strip research hero block + make registry sources non-navigating

Two small UI-only changes. No backend or prompt changes.

## 1. Delete the welcome hero block on /research

In `src/routes/_authenticated/research.tsx`, remove the three elements shown in your screenshot from the empty state:

- The Seeger Weiss logo image at the top
- The "What would you like to research?" heading
- The "Mass tort and complex litigation — MDLs, causation science, regulatory actions, and precedent — with every answer cited." subtitle

Keep the composer, starter suggestions, and the small security footnote. The composer becomes the centered first element, with adjusted spacing so the layout still looks intentional (slightly more top room, composer vertically centered).

## 2. Registry/corpus sources never open or navigate

In `src/components/chat/SourcePanel.tsx`:

- Source rows: when a source is from our internal registry/corpus (`authority === "registry"` or no external URL), remove the "Open ↗" action entirely — the row shows favicon/doc glyph, title, and metadata only. Web sources with real external URLs keep the Open link.
- Related cards: registry/internal sources render as a plain non-interactive card (no `<a>` wrapper, no hover lift), so clicking them does nothing. External web cards still link out.

## Technical notes

- Files: `src/routes/_authenticated/research.tsx`, `src/components/chat/SourcePanel.tsx`.
- Detection: reuse the existing `hostOf(source.source_url)` — no host means internal; plus explicit `authority === "registry"` check.
- Verify: typecheck, then load /research, confirm the empty state shows only composer + suggestions, and that a registry source row has no Open link and its Related card is inert.
