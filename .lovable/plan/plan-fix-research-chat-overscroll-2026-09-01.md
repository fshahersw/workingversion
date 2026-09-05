# Plan: Fix research chat overscroll

## Changes

- Remove the synthetic trailing spacer from `src/components/chat/ChatView.tsx`. The spacer currently adds up to nearly a viewport of blank scrollable height after the final response, on top of the composer clearance.
- Keep new-question positioning, but clamp it to the chat container’s natural maximum scroll position instead of manufacturing empty space so a short turn can reach the very top.
- Preserve smooth streaming follow and immediate cancellation when the user scrolls manually.
- Remove the “Jump to latest” button and its button-only state/callback code completely.
- Keep the fixed composer clearance so the final lines remain readable above the composer, without allowing viewport-scale blank overscroll.

## Scope

Frontend-only change in `src/components/chat/ChatView.tsx`; no changes to streaming, messages, sources, prompts, or backend behavior.

## Verification

- Open a multi-turn research conversation and confirm scrolling stops shortly after the final output rather than continuing through a blank viewport.
- Submit both short and long prompts and confirm the newest question moves into view without creating artificial scroll space.
- Confirm streaming remains smooth, manual upward scrolling is not overridden, and no “Jump to latest” button appears.
- Check desktop and mobile layouts and run the relevant typecheck.
