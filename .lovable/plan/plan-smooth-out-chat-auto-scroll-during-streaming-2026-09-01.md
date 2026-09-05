# Plan: Smooth out chat auto-scroll during streaming

## What's actually causing the jerk

Confirmed in `src/components/chat/ChatView.tsx`:

1. **The spacer re-measures on every token.** The measuring effect (lines 178–206) depends on `lastAnswerLen` *and* on `spacer` itself. Streamed text changes `lastAnswerLen` roughly every animation frame, so the effect re-runs constantly, recomputes the trailing spacer, and shrinks it as the answer grows. That means the page height changes underneath the reader while text streams — the classic "screen tugs" symptom, and it gets worse in a long multi-turn conversation because the measurement is relative to total `scrollHeight`.
2. **The spacer shrink fights the in-flight smooth anchor scroll.** The anchor effect (lines 211–230) starts a `behavior: "smooth"` scroll to put the new question at the top. While that animation runs, the spacer effect keeps mutating page height, so the browser re-clamps the target mid-animation.
3. **Follow-mode scrolls in discrete hops.** The follow effect (lines 233–242) fires a `setTimeout(80ms)` + `scrollTo({behavior:"auto"})` on every answer-length change — stepped 80ms jumps instead of continuous motion.

## The fix (one file, `ChatView.tsx`, presentation only)

**Stable spacer per turn.** Measure the trailing spacer once, when a new question appears (and on container resize via `ResizeObserver`), from the question block's own height — not from total `scrollHeight` and not on answer-length changes. Keep it constant for the rest of the turn so the document height never shifts while text streams. Remove `lastAnswerLen` and `spacer` from that effect's dependencies.

**Anchor scroll owns the viewport briefly.** When anchoring a new question, set an "animating" flag, run the smooth scroll, and ignore follow-mode and re-measures until the scroll settles (detected by scroll position going quiet, with a timeout fallback). No other code moves the viewport during that window.

**Continuous follow instead of hops.** Replace the timeout-based follow with a single `requestAnimationFrame` loop that runs only while follow-mode is on and content is growing. Each frame it eases `scrollTop` toward the bottom (a small fraction of the remaining distance, capped per frame) and stops when it's within a pixel. This tracks streaming text as smooth motion rather than 80ms jumps, and it self-cancels the moment the user scrolls up.

**Wheel/touch cancels follow immediately.** Add passive `wheel` and `touchstart` listeners that turn follow off instantly, so a manual scroll during streaming is never yanked back by an in-flight frame.

## Not changing

Streaming/SSE, the writer, prompts, the source rail, the timeline, the composer, and `use-smooth-text.ts` all stay exactly as they are. This is scroll choreography only.

## Verification

Typecheck, then in Playwright at 1286 wide: run a conversation of 3+ turns, confirm the new question anchors to the top once and holds steady while the answer streams, that scrolling up mid-stream is never overridden, that scrolling back to the bottom resumes smooth follow, and that no blank gap or height jump appears between turns.
