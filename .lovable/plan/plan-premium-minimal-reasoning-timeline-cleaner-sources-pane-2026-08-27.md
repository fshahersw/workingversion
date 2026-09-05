# Plan: Premium, minimal reasoning timeline + cleaner sources panel

Two files: `src/components/chat/AgentTimeline.tsx` and `src/components/chat/SourcePanel.tsx`. UI-only; no backend, prompt, or data changes.

## 1. Reasoning timeline — remove the pill

The collapsed-after-done state currently renders a rounded pill ("N sources · N rounds · N agents ▾"). Replace with a quiet, editorial disclosure:

- **No pill.** A plain text row: small status dot, muted 11px text ("42 sources · 2 rounds · 6 agents"), and a chevron that rotates on expand — no border, no filled background, no pill shape.
- Subtle hover (text darkens slightly), generous hit area, smooth height animation kept.
- Tool "tag" chips inside each agent row (`rounded-md border …` boxes) become **plain muted text separated by thin middle dots** — no bordered chips anywhere in the timeline.
- The count chip next to each agent name becomes plain tabular muted text (e.g. `· 12`), not a filled chip.
- Keep: vertical rail, colored status dots, check-on-done, shimmer only while live, spring/height animations.

## 2. Sources panel — cleaner and more modern

`SourcePanel` / `SourceCard` currently stacks multiple colored pill chips per card (tier chip, authority chip, currency dots). Simplify:

- **Header:** keep "Sources (N)" but drop the heavy uppercase tracking to a lighter, modern title style.
- **Source cards:** flatter, more premium look — thinner border, slightly larger radius, less padding noise; remove the colored tier/authority **pill chips** and render tier + authority as one quiet line of muted metadata text (e.g. `T2 · Statute`), with a small colored tick/dot only for tier.
- Keep "Current / Confirm currency" but as a single subtle dot + muted text (no green/amber chip styling).
- Content well: lighter background, hairline border, keep scroll + quote highlighting behavior unchanged.
- Footer row: keep "View source" link and Ask AI; restyle the Ask AI trigger from a pill to a minimal ghost button (sparkle icon + text, hover accent only).
- Empty state unchanged in behavior; minor spacing polish only if trivial.

## Verification

- Typecheck; load `/research`, run a query in Playwright, screenshot the live timeline, the settled (post-answer) disclosure row, and the sources panel with several sources to confirm the new look.
