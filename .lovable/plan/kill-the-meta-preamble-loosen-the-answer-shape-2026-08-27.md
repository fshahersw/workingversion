# Kill the meta-preamble, loosen the answer shape

Two changes to the research writer, both prompt-level. No orchestration, retrieval, or UI changes.

## 1. No more "no sources were retrieved" preambles

Today the writer prompt tells it to state plainly, in the opening lines, when a matter is not in the registry. Combined with the empty-source case, that produces the paragraph you saw: a self-referential apology about what it could not retrieve, before any answer.

New rule set for the writer:
- Never open with meta-commentary about the research process, retrieval, sources, the registry, or the model's own knowledge. The first sentence answers the question.
- Never write sentences of the form "no sources were retrieved", "the answer below reflects general practice", "I cannot cite…". Provenance is expressed by the presence or absence of a [S#] marker, plus a short inline qualifier where a specific fact is genuinely unverified.
- When a matter genuinely is not in the firm's registry, that fact belongs in one short clause where it matters — or in the closing open-questions list — not as an opening disclaimer.
- With no sources at all: answer directly from general practice, unmarked, with any genuinely docket-specific unknowns named briefly at the end. Still no preamble.

## 2. Dynamic output shape

Current writer prompt mandates a fixed skeleton (headings + always-on "Open questions / confirm on the docket" closing section), which is why every answer looks identical.

New guidance:
- Match length and format to the question. A one-line factual question gets a couple of sentences with no headings. A posture or strategy question gets structured sections. Never pad a short answer to look substantial.
- Headings, bullets, and tables are optional tools, used only when the content is actually list-like or comparative. Prose is the default for short answers.
- The "Open questions" section is conditional: include it only when something is genuinely time-sensitive, contested, or unverified, and drop it entirely otherwise.
- Keep the citation contract unchanged — [S#] markers still attach to every sourced factual sentence.

## Technical detail

- `src/lib/agents/prompts.ts` — rewrite `writerPrompt()` rules: add the anti-preamble ban, replace the fixed structure/closing-section rules with adaptive-length guidance.
- `src/lib/system-prompt.ts` — `CITATION_CONTRACT` currently ends with "End with an 'Open questions...' list"; soften to conditional. `AGENT_BRIEFS.writer` currently prescribes the four-part memo; loosen to "shape the answer to the question".
- `src/lib/agents/orchestrator.server.ts` — no logic change; the "No sources were retrieved." filler string in the writer's user message becomes a neutral instruction that doesn't invite the model to narrate it.

Verification: typecheck, then two live `/research` runs — one conversational/short question and one corpus-absent matter — confirming neither answer opens with a retrieval disclaimer and lengths differ.
