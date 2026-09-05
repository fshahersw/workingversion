# Plan: Remove the oversized empty region in short chats

## What is extending the height

The composer itself is fine (measured live: 44–52px textarea, ~103px form — normal). The height comes from the **trailing spacer** in `src/components/chat/ChatView.tsx` (lines 171–192, rendered at lines 345–351):

```text
spacer = chat viewport height − last turn height − 24
```

Its purpose is legitimate: it creates just enough scroll room so a newly submitted question can anchor to the top of the viewport (the approved "question-anchored" scroll design). But it is computed for **every** last turn, including the very first one. With a short prompt like "hi", the turn is only ~300px tall, so the spacer becomes almost a full viewport of dead space. Verified in a live session: after one short query, the chat column shows the answer, then a giant empty gap down to the composer — the scroll area's height is roughly doubled by the spacer.

For a first (or only) short turn the spacer achieves nothing: the question is already at the top of the viewport, no scrolling is needed, and the empty region is pure visual noise. It also makes the "Jump to latest" button appear for no reason, since the page is now artificially scrollable.

## The fix (ChatView.tsx only)

Add a necessity check to the spacer measurement: only keep the spacer when scroll room is actually required to anchor the last question — i.e. when there is earlier content above the last turn.

- In the `measure()` callback, compute `turnTop` (already computed: distance of the last user message from the content start).
- If `turnTop <= 0` (the last turn is the first turn, nothing above it to scroll past), set spacer to `0` and skip the rest.
- Otherwise keep the existing formula unchanged (`clientHeight − turnHeight − 24`, clamped at 0, 8px hysteresis).

Result:

- Single short turn: no spacer, answer sits directly under the question, chat ends naturally — no void, no phantom scrollbar, no "Jump to latest".
- Multi-turn chat: unchanged behavior — submitting a follow-up still gets exactly enough room to pin the new question at the top, per the existing scroll design.

## Verification

Typecheck, then Playwright at 1280px: send a one-word query and confirm no empty gap below the answer and no scrollbar; send a follow-up and confirm the new question still anchors to the top with correct scroll room.
