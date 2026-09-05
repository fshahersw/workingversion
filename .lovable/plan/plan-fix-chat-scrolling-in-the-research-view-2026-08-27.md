# Plan: Fix chat scrolling in the research view

The chat column currently runs three scroll controllers at once in `src/components/chat/ChatView.tsx`:

1. a per-frame "chase the bottom" loop while the writer streams,
2. a "pin to bottom" effect on every answer-length change,
3. the new "anchor the question at the top" effect on submit.

They fight each other, and the fixed `60vh` bottom spacer means "bottom" is empty space — so the view yanks itself off the question and down into blank area while text streams. That is the jumpiness.

## The fix: one scroll controller, question-anchored

Replace all three with a single, predictable behavior modeled on how research assistants read:

- **On submit** (Enter, send button, or a suggested follow-up), scroll the new question to the top of the chat viewport, once, smoothly. Nothing else moves it after that.
- **While the answer streams**, do not auto-scroll. The answer grows downward under the anchored question and the user reads at their own pace. No per-frame chase loop, no pin-to-bottom on token flushes.
- **Follow-mode opt-in**: if the user manually scrolls to within ~120px of the bottom, gentle follow resumes (throttled, not per-frame) until they scroll up again. Scroll position is tracked with one passive scroll listener instead of length-change effects.
- **Jump to latest**: a small floating button appears above the composer only when the newest content is off-screen below; clicking it smooth-scrolls to the end and re-enables follow.

## Spacer

Replace the fixed `h-[60vh]` filler with a measured spacer that is exactly big enough for the last turn to reach the top of the viewport (viewport height minus the last turn's height, clamped at 0). No dead space once the answer is long, and no stuck-below-top question when it is short.

## Scope

Only `src/components/chat/ChatView.tsx`. No changes to the source rail, timeline, backend, prompts, or streaming.

## Verification

Typecheck, then in Playwright at 1280 wide: send a query, confirm the question locks to the top and the view does not jerk while the answer streams; scroll up mid-stream and confirm nothing pulls the view back; scroll to the bottom and confirm follow resumes; send a second query and confirm it re-anchors cleanly with no blank gap left over.
