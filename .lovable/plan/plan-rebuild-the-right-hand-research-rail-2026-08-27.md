# Plan: Rebuild the right-hand research rail

UI-only work in `src/components/chat/SourcePanel.tsx` (plus a small favicon helper). No backend, prompt, or retrieval changes.

## 1. Kill the dead filter tabs

The All / Authorities / Corpus / Press buttons don't earn their space. Remove them and the "at a glance" stat strip. Keep only a slim header: title, count, and a "Clear" affordance when a citation is selected.

Grouping stays (Courts & agencies, Firm corpus, Supporting coverage) as quiet section labels, so the information the tabs conveyed is still visible without dead controls.

## 2. Favicons for every web source

Each row gets a 16px favicon instead of the tier dot:

- Web sources: `https://www.google.com/s2/favicons?domain=<host>&sz=64`, lazy-loaded, with a graceful fallback to a monogram tile (first letter of the host) if the image errors.
- Corpus/internal sources (no external host): a small document glyph tile in brand navy tint instead of a favicon.

## 3. No auto-expansion on citation click

Clicking a citation in the answer currently force-opens the full passage. Change to: the row highlights, scrolls into view, and shows the matched quote as a compact 2–3 line snippet with the quote highlighted. The full passage only opens when the user clicks "Read passage". Expansion state becomes purely user-controlled.

## 4. Colour + style pass

- Warmer, lighter surface: panel background a hair off the chat canvas, hairline `border-border/50` dividers between rows instead of hover-only blocks.
- Selected row: soft brand-navy left bar + very light tinted background (no heavy fill).
- Typography: citation title 12.5px medium navy, metadata one muted 10.5px line (`host · date`), snippet 11px at 70% opacity.
- Remove leftover amber "verify" styling in favour of a neutral muted `verify` tag.

## 5. New: "Related" cards under the sources

This is the answer to "can we output rectangular related research/laws/headlines". Below the grouped sources, a **Related** section of compact rectangular cards built from what we already retrieved — no new fetching:

- Up to 6 sources that the answer did *not* cite (retrieved but unused), rendered as rectangles: favicon + host, 2-line title, and a one-line "why this matters" derived from the source's first sentence.
- Cards are horizontally full-width, stacked, with a subtle hover lift and click-through to the source URL.
- Section is hidden entirely when there are no uncited sources.

Optionally the same card shape is reused for a small "Authorities cited" strip at the top when the answer cites statutes/rules, grouped by citation family.

## Technical notes

- `SourcePanel.tsx` loses `filter` state, the `Stat` component, and the tier-chip logic; gains a `Favicon` component and a `RelatedCards` section.
- Uncited detection: compare `sources[].ref` against the refs appearing in the current assistant answer text (already available where the panel is rendered in `ChatView.tsx`); pass a `citedRefs: Set<string>` prop down.
- Selection behaviour change touches the `open = expanded || selected` line in `SourceRow`.

## Verification

Typecheck, then load `/research` in Playwright with an authenticated session, run a query, and screenshot: settled panel with favicons, a clicked citation (no auto-expand), and the Related cards section.
