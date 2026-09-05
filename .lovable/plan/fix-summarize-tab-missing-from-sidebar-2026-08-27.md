# Fix: Summarize tab missing from sidebar

## Root cause
The Summarize page exists and works (`/summarize`, verified live with a signed-in session — drop zone, focus input, reasoning rail all render). But `src/components/app-shell.tsx` renders nav items by hardcoded index: `primaryNav[0]` (Home) at line 149 and `primaryNav[1]` (Research) at line 190. `primaryNav[2]` (Summarize, added at line 30) is never rendered, so the tab never appears in the sidebar.

## Change
- In `src/components/app-shell.tsx`, add a third `NavRow` after the Research row rendering `primaryNav[2]` with `active={pathname.startsWith("/summarize")}` — order: Home → Matters → Research → Summarize.
- Check for any mobile/bottom navigation in the same file and add Summarize there too if it has its own list.

## Verification
- Signed-in Playwright check: sidebar shows Home, Matters, Research, Summarize (collapsed + expanded), clicking Summarize navigates to `/summarize`, active state highlights correctly.
- `npx tsgo --noEmit` passes.
