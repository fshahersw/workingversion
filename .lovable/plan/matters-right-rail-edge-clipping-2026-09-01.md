# Matters right rail edge clipping

Scope: `src/components/matters/MatterWorkspace.tsx` only — the right-side matter metadata rail is being clipped by the viewport right edge.

## Diagnosis

The rail is a fixed 280px `motion.aside` with `overflow-hidden`. Inside, `RightRail` renders a `ScrollArea` also fixed at `w-[280px]` with `p-4` content padding. The likely overflow sources are:

- `Field` rows use `truncate` on the value but the flex item has no `min-w-0`, so long docket/court/judge values can refuse to shrink and push past the rail boundary.
- Party and counsel list items are plain `<span>` text without truncation/wrapping guards.
- The 3-column `Stat` grid and section headings are tight inside 248px of usable width.

## Changes

1. **Fix `Field` truncation**
   - Add `min-w-0` to the value `<dd>` so `truncate` actually takes effect in the flex row.
   - Keep `text-right` alignment.

2. **Guard list items**
   - Wrap party and counsel names in `min-w-0 truncate` spans so long firm/attorney names do not overflow.

3. **Reclaim a few pixels safely**
   - Reduce rail content padding from `p-4` to `p-3.5`.
   - Reduce the `motion.aside` width and inner `ScrollArea` width from 280px to 272px so the border + padding + content fit comfortably without touching the viewport edge.

4. **Verify no horizontal overflow**
   - In the preview at a large viewport (≥1280px), confirm the rail is fully visible, no horizontal scrollbar appears on the page, and long field values truncate with an ellipsis.
