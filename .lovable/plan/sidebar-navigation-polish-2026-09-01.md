# Sidebar Navigation Polish

## Goal

Clean up and polish the sidebar in `src/components/app-shell.tsx` — keep the current page order exactly as-is, remove the ⌘M keyboard chip from the Matters tab, and make the whole rail feel tighter, better aligned, and smoother during expand/collapse.

## Keep unchanged

- Page order: Home → Matters → Research → Calendar → Discovery.
- All existing route behavior, active states, and mobile drawer logic.
- The edge collapse/expand toggle button.

## Changes

### 1. Remove the Matters keyboard chip

- Delete the `<kbd>⌘M</kbd>` element from the Matters trigger row.
- Keep the ⌘M shortcut behavior (the `onClick` opens the MatterSelector), just remove the visible chip.

### 2. Tighter, cleaner nav rows

- Standardize row height across all nav items and the footer (e.g. `h-9` everywhere).
- Equalize icon/text spacing so expanded labels sit on the same baseline and collapsed icons stay perfectly centered.
- Use consistent horizontal padding in expanded mode and identical tap targets in collapsed mode.
- Make the active indicator a soft rounded pill instead of a hard left edge bar, applied uniformly to NavRow, Matters trigger, and footer rows.

### 3. Smoother expand/collapse

- Slightly lengthen the width transition and use a calmer ease curve (`duration-300 ease-[cubic-bezier(0.4,0,0.2,1)]`).
- Add a subtle fade/slide on labels so text does not visibly reflow mid-animation.
- Ensure the logo/wordmark swap between collapsed and expanded feels seamless.

### 4. Consistency details

- Keep the "Workspace" section label.
- Ensure the collapse toggle stays vertically aligned with the nav area.
- Preserve accessibility: `aria-label`, tooltips, and keyboard focus rings.

## Technical notes

- All edits stay inside `src/components/app-shell.tsx`.
- No backend, auth, or route changes.
- Verify desktop expanded, desktop collapsed, and mobile drawer states.
