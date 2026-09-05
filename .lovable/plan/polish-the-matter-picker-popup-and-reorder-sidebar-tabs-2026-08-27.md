# Polish the matter picker popup and reorder sidebar tabs

## Goal
Make the "Select a matter…" popup feel smoother and cleaner, and reorder the sidebar to **Home → Matters → Research**.

## Changes

### 1. Sidebar reorder (`src/components/app-shell.tsx`)
- Order nav as: Home, then the Matters section ("Select matter…" picker button), then Research.
- Move the "Matters" group heading + matter button between Home and Research instead of after both; keep the "Workspace" heading for Home/Research or fold into a single clean list (single section, no duplicate headings).
- Keep all existing behavior: active states, ⌘M shortcut, collapse toggle, mobile drawer.

### 2. Smoother popup animation (`src/components/ui/dialog.tsx` / `command.tsx`)
- Soften the CommandDialog entrance/exit: gentle scale (0.97 → 1) + fade with ~180–220ms ease-out, matching smooth exit animation instead of an abrupt snap.
- Softer overlay: lighter backdrop with a subtle blur, eased fade.
- Scope the animation tuning to the command/matter dialog so other dialogs are unaffected (or keep it global if the current animations are already shared and plain — verify in dialog.tsx).

### 3. Cleaner matter rows (`src/components/matters/MatterSelector.tsx`)
- Refine row layout: consistent padding, softer hover/selected background, lighter icon tile, better truncation of long case names.
- Tidy metadata: MDL badge, docket number, doc/entry counts with quieter styling.
- Nicer empty/loading state text and a cleaner, minimal footer hint bar.

## Verification
- `npx tsgo --noEmit` passes.
- Visual check in the preview: open picker via sidebar button and ⌘M, confirm smooth animation, row polish, and new Home → Matters → Research order on desktop (expanded + collapsed) and mobile drawer.

## Out of scope
- No backend/data changes, no new pages, no changes to matter detail views.
