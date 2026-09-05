# Premium Polish: Summarizer Ask Bar

Scope: `src/components/summarize/SummarizeView.tsx` only (plus small token additions in `src/styles.css` if needed). No logic, search, or Ask pipeline changes.

## What changes

### 1. Replace the "AI-design" Ask button
- Remove the generic `Sparkles` icon from the Ask button.
- Replace with a refined mark: a subtle `Scale` or `FileSearch`-style glyph at smaller optical size (`h-3.5 w-3.5`, 1.5px stroke), or a clean text-only "Ask" treatment.
- Make Ask the primary action: solid `brand-navy` fill with a hairline inner highlight, soft elevation shadow (`shadow-sm` → deeper on hover), and `active:scale-[0.98]` press feedback.
- Add a keyboard hint chip (`⌘⏎` / `Enter`) rendered as a small `kbd`-style badge inside the button on desktop — the premium detail users notice.
- Loading state: replace plain disabled with a subtle shimmer sweep or an inline dot-pulse plus "Reading…" label.

### 2. Unify the search form row
- Wrap Search input + Search button + Ask button in one bordered "control bar" container (rounded-xl, hairline border, focus-within ring) so the three controls read as one instrument instead of three floating elements — Everlaw/Thomson Reuters pattern.
- Demote the secondary "Search" button to a ghost/quiet treatment inside the bar; Ask stays the sole filled primary.
- Consistent 40px heights, 10px radii, tighter gap rhythm.

### 3. Micro-polish pass
- Stats row ("N files · N pages indexed"): tabular numerals already in place — add a subtle divider-dot treatment and slightly warmer muted tone.
- Smooth 150–200ms ease-out transitions on all hover/press states in this region.
- Ensure disabled states use reduced opacity with no layout shift.
- Keep semantic tokens only (brand-navy, brand-orange accents already defined) — no hardcoded colors.

## Verification
- Visual check via screenshot of `/summarize` (light theme), hover and loading states.
- Existing pile tests untouched; no functional changes.
