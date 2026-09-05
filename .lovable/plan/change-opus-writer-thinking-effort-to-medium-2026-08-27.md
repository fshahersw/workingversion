# Change Opus writer thinking effort to medium

## What changes

In `src/lib/agents/orchestrator.server.ts`, update the final answer writer call from:

```ts
effort: "high"
```

to:

```ts
effort: "medium"
```

This reduces the adaptive-thinking budget for `claude-opus-4-8` during the streamed final answer generation. Router and sub-agent effort settings remain unchanged.

## Files touched

- `src/lib/agents/orchestrator.server.ts` (single line)

## Verification

- TypeScript typecheck.
- Confirm `/research` route still responds HTTP 200.
- Optionally run one short research query and compare writer latency/quality.
