# Writer: 1.5x budget + tighter, cleaner output

Give the final research writer more room to finish an answer, and sharpen its prompt so the extra room goes to on-topic substance and clean formatting — not filler.

## 1. 1.5x token budgets

In the orchestrator's writer step:

- conversational: 2,000 -> 3,000
- scoped: 4,000 -> 6,000
- deep: 6,000 -> 9,000

In the Bedrock Claude client, the hard floor that thinking and answer share:

- `max_tokens` floor: 8,000 -> 12,000 (the non-Anthropic path's 1,024 floor -> 1,536)

Reasoning effort stays as-is (low for conversational, medium otherwise) so latency does not grow with the budget.

## 2. Prompt: stay on topic, no unrelated noise

Add a short, high-priority "SCOPE DISCIPLINE" block to the writer prompt:

- Answer only what was asked. Do not add adjacent background, related litigation, general primers, or "you may also want to know" material the question did not ask for.
- Drop any retrieved source that does not bear on the question, even when it is cited-worthy on its own. Extra budget is for depth on the asked point, never for breadth.
- No process narration, no restating the question, no summary-of-the-summary closer, no open-questions or next-steps list.
- A short answer is correct when the question is short; never pad to fill the budget.

## 3. Prompt: neat formatting

Replace the current loose formatting guidance with explicit, consistent rules:

- Bottom line first, one or two sentences, no heading above it.
- Then at most three short sections; headings only when there is more than one distinct sub-answer.
- Dates written consistently (Mon D, YYYY); figures with units/currency; party and case names bolded on first use only.
- Bullets only for genuinely enumerable items, one line each, never nested more than one level.
- Tables only for true side-by-side comparison, max four columns.
- `[S#]` markers ride at the end of the clause they support, never stacked in a row.
- No trailing caveat paragraph.

The deep mode's hard 400-word cap is raised to 600 to match the larger budget, while keeping "selection, not coverage" as the rule.

## Technical notes

Files touched: `src/lib/agents/orchestrator.server.ts` (writerBudget), `src/lib/agents/bedrock-claude.server.ts` (max_tokens floors), `src/lib/agents/prompts.ts` (`WRITER_MODE_BRIEF.deep`, new scope block, formatting section of `LEGAL_SYNTHESIS_FRAMEWORK`). No backend, schema, or UI changes; existing tests should stay green.
