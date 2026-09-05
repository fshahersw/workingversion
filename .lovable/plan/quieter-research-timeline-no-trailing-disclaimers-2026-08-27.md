# Quieter research timeline + no trailing disclaimers

## 1. Timeline shows work, not prose

In the research reasoning rail, drop the streamed model prose and keep only structure and motion:

- Remove the round `reasoning` paragraph and the `scratch_note` line.
- Remove each sub-agent's `focus` and `summary` text.
- Keep: round number + phase label ("Plan", "Refine · Round 2"), the "complete" chip, each agent's name with its colored node, the shimmer while running, the check on completion, and the "N found" count.
- Keep the collapsed summary pill and the "Thinking through the next step…" shimmer.

Result is a compact list of phases and tools with live status, no paragraphs. Nothing in the SSE stream or state changes — the prose is simply not rendered, so it can be re-enabled later.

## 2. Remove closing disclaimers from answers

Two sources produce the trailing boilerplate:

- The firm system prompt ends with "This is attorney work product for internal use; it is not legal advice to a client." That line is deleted.
- The writer adds its own caveat paragraphs about secondary trackers needing corroboration. The writer prompt gains an explicit rule: no closing disclaimer, no work-product notice, no generic "corroborate against the docket" paragraph. Source reliability caveats belong inline on the sentence they affect, and the existing "Open questions / confirm on the docket" list stays as the only closing section.

## Technical notes

- UI edit: `src/components/chat/AgentTimeline.tsx` only (drop the `Thought` renders; the helper stays for reuse). No changes to `use-chat.ts`, the orchestrator, or SSE events.
- Prompt edits: `src/lib/system-prompt.ts` (delete the work-product line) and `src/lib/agents/prompts.ts` (`writerPrompt` no-disclaimer rule).
- Verify with a typecheck and one live `/research` run to confirm the answer ends without the boilerplate and the rail renders compactly.
