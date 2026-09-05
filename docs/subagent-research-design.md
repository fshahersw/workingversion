# Orchestrator-Subagent Research — Design & Cost Model

Status: shared **subagent primitive BUILT + unit-tested** (`subagent.server.ts` +
pure `subagent-plan.ts`, 2026-09-05); not yet wired into a caller. Track A (light
file subagents) and Track B (standalone async Deep Research page) pending. Approved
2026-09-05 (Firas): "add light subagents for file workflows, and a standalone
Deep Research page with its own backend, async processing, cleanly separated from
chat." Async substrate: in-process V1 behind a swappable Executor, AgentCore
Runtime as the prod destination.

This is the Phase 3 frontier bet from the agentic-workflow plan: a scoped
orchestrator-subagent path that trades ~4–15x tokens for a large quality gain on
high-value breadth-first research — the use case Anthropic explicitly names as
appropriate for multi-agent (legal due diligence, biomedical literature review),
and exactly what this product does.

## Why (grounded)

Anthropic's production Research system (orchestrator + parallel subagents +
citation agent) measured **+90.2%** over single-agent Opus on their internal
research eval, at **~15x** the token cost of a chat turn (~4x a single agent).
Token usage alone explained ~80% of the eval-score variance. The decisive lesson:
**breadth-first questions parallelize** — independent sub-questions researched
concurrently by focused subagents beat one agent serially juggling everything in a
single context window. The cost is only justified when task value is high, so we
scope it to the deliverable, not to every query.

Our current agent is a single Sonnet-5 tool loop (`research-agent.server.ts`) with
a merged synthesis turn. It is good, but on the hardest cross-MDL cases the
single context window is the bottleneck: the loop broadens shallowly, the coverage
gate has to re-query, and synthesis compresses everything at once. Those are the
cases where subagents pay off.

## Scope — where this runs (and where it must NOT)

| Mode | Engine | Rationale |
|---|---|---|
| conversational | single-agent (unchanged) | no research; 15x tokens on "thanks" is absurd |
| fast | single-agent (unchanged) | latency-bound; 30s deadline; not breadth-first |
| think (chat) | single-agent (unchanged) | one focused question; single context is fine |
| **think + doc/Research deliverable** | **orchestrator-subagent** | high-value, breadth-first, multi-part; value justifies cost |

Gate: `detectDocRequest().wants === true` **and** a new flag
`BEDROCK_SUBAGENTS=1` (default off). The doc-deliverable overlay already widens the
budget and is the natural trigger. Everything else keeps the proven single-agent
loop. This mirrors Anthropic: multi-agent for breadth-first research, not for
everything.

## Architecture

Evolve the EXISTING `report.server.ts` pipeline (PLAN → parallel DRAFT → REFINE →
VERIFY). Today the parallel drafters share ONE pre-gathered SourceBook. The change:
each parallel unit becomes a **research subagent** that gathers its OWN sources for
its sub-question before anything is written.

```
LeadResearcher (orchestrator)
  ├─ decompose question → N sub-questions (mutually exclusive, breadth-first)
  ├─ for each: emit a delegation contract (objective, output format, tools, bounds)
  │
  ├─ Subagents (parallel, bounded pool)      ← each is a focused mini research loop
  │    ├─ sub-agent 1: own tool budget + context, writes to the SHARED book
  │    ├─ sub-agent 2: ...
  │    └─ sub-agent N: ...
  │
  ├─ shared SourceBook already holds every source (globally-unique [S#], no merge)
  ├─ Synthesizer (Opus) → the deliverable, citing the merged sources
  └─ CitationAgent → faithfulness judge (already built) over the final answer
```

- **LeadResearcher** = the planner. Reuses `PLAN_TOOL` in `report.server.ts` but the
  plan items become *research objectives*, not just section headers. Model: a
  reasoning tier (Sonnet 5, or Opus 5 for the hardest) — decomposition quality is
  the highest-leverage decision (Anthropic: bad delegation → duplicated work or
  gaps).
- **Subagents** = focused loops. Each runs a trimmed `streamConverseToolLoop` with
  its own `callBudget`, sharing ONE run `SourceBook` (add() is synchronous, so
  race-free under `Promise.all`; refs stay globally unique with NO merge step).
  Contexts still stay isolated — each subagent's conversation holds only its own
  tool results; the book is just the shared citation registry.
  Model: Sonnet 5 for genuinely analytical sub-questions; **Nemotron Nano 3
  workhorse** for narrow retrieve-and-extract sub-questions (e.g. "pull the docket
  posture of MDL X", "list the settlement amounts"). Mixed tiering per sub-question
  keeps cost sane.
- **Synthesizer** = premium single pass over the merged SourceBook. Model: Opus 4.8/5
  (`BEDROCK_SYNTHESIS_MODEL`). This is where the quality shows.
- **CitationAgent** = the faithfulness judge (`faithfulness.server.ts`), already a
  proto-citation-agent. It runs over the synthesized answer exactly as it does now.

### Delegation contract (per subagent)

Anthropic's core lesson: subagents need explicit boundaries or they duplicate work.
Each subagent prompt MUST carry:
1. **Objective** — the one sub-question it owns, one sentence.
2. **Output format** — structured findings: `{ claim, sourceRefs, confidence }[]`,
   NOT prose (the Synthesizer writes prose).
3. **Tools/sources guidance** — which of the ~23 tools fit this sub-question
   (e.g. PubMed + FDA for causation-science; RECAP + DocketBird for docket posture).
4. **Boundaries** — "do NOT cover topics X, Y (owned by sibling subagents)."

The `focus` field in the existing `PLAN_TOOL` already encodes mutual exclusivity —
extend it with `tools_hint` and `boundaries`.

## Cost model

Anchored to the v2 calibration (single-agent Think baseline):
- avg latency ~75s, first token ~50s, 20–36 sources, 4–5 agent steps, answer
  ~5–7k chars.
- Token accounting is not yet summed in logs — **the Run Inspector should sum
  input/output tokens per run so this model becomes measured, not estimated.**

Estimate for the subagent path (N = 4–6 subagents typical for a Research
deliverable):

| Item | Single-agent Think | Subagent Research |
|---|---|---|
| Research loops | 1 | N (parallel) + 1 lead plan |
| Token cost (rel.) | 1x | ~4–6x (mixed-tier subagents), up to ~15x if all Sonnet + broad |
| Wall-clock latency | ~75s | ~90–150s (dominated by slowest subagent + synthesis, NOT the sum) |
| Quality (expected) | baseline | large gain on breadth-first / cross-MDL; marginal on narrow |

Cost controls (mandatory):
- **Per-run token budget cap** — abort/degrade to single-agent if projected spend
  exceeds a ceiling (`BEDROCK_SUBAGENT_MAX_TOKENS`).
- **Bounded subagent pool** (`mapPool`, concurrency ~3–4) — protects Bedrock rate
  limits under concurrent users; the shared full-jitter backoff already exists.
- **Workhorse subagents where possible** — a Nemotron sub-question is ~1/25th the
  output-token price of Sonnet.
- **N is content-driven** — the LeadResearcher picks 3 for a narrow question, up to
  6 for a broad one (the PLAN already sizes sections to scope).

Rule of thumb (Anthropic, adopted): only spend the multiplier when the question is
genuinely breadth-first and the deliverable is high-value. A single-issue Think
question should stay single-agent even in doc mode.

## Concurrency & multi-user safety

The current single shared Code-Interpreter sandbox session (flagged risk:
`code-interpreter.server.ts`) is NOT safe for parallel subagents that each write
files. Before subagents touch the sandbox: either per-subagent sessions or a
per-run namespaced working dir. For pure retrieval/analysis subagents (no sandbox),
the existing per-request isolation is fine. **Do not let parallel subagents share
one mutable sandbox.**

## Observability (depends on the Run Inspector)

The trace collector (`trace.server.ts`) keys events by `run`. For subagents, add a
`parent` field to subagent `agentLog` lines and let the Inspector render a **nested
timeline**: lead plan → N subagent lanes (each with its own steps/tools/latency) →
merge → synthesis → faithfulness. This is how we watch it work and how we measure
the gain vs single-agent (run the same eval case both ways, compare score + tokens
+ latency in the Inspector / eval harness). **No default-on until measured.**

## Failure modes & mitigations

| Risk | Mitigation |
|---|---|
| One subagent fails/throttles | tolerate partial: synthesize from the subagents that returned; log the gap (never fail the whole run on one subagent) |
| Token blowup | per-run budget cap + workhorse subagents + bounded N |
| Duplicated work across subagents | strict delegation boundaries in the contract; mutual-exclusivity already enforced in PLAN |
| Latency regression | parallel (not serial) subagents; deadline per subagent; degrade to single-agent past a wall-clock ceiling |
| [S#] collisions | none by construction — subagents share one SourceBook, so refs are globally unique; no merge step exists |

## Rollout

1. Build the Run Inspector (done — this design's prerequisite) + add per-run token
   summing.
2. Implement behind `BEDROCK_SUBAGENTS=1`, doc-mode only, feature-flagged off.
3. A/B on the eval harness: same cases, single-agent vs subagent, compare
   score / tokens / latency in the Inspector.
4. Default-on for Research deliverables ONLY if the measured score gain justifies
   the measured token multiplier. Otherwise keep it opt-in.

## Files touched (when built)

- `report.server.ts` — PLAN items become research objectives; DRAFT stage becomes
  parallel subagent loops + merge + synthesis.
- `research-agent.server.ts` — route doc-mode + `BEDROCK_SUBAGENTS` to the new path.
- `bedrock-stream-tools.server.ts` — reuse `streamConverseToolLoop` for each
  subagent with an isolated SourceBook + budget.
- `trace.server.ts` — `parent` field for nested subagent timelines.
- New (BUILT): `subagent.server.ts` (planner + runner + bounded parallel pool) and
  pure `subagent-plan.ts` (types, plan parsing, pool, findings assembly);
  `subagent-plan.test.ts` (6 tests). Shares one SourceBook; flag/caller-gated.

## References

- Anthropic, "How we built our multi-agent research system" (orchestrator-worker,
  LeadResearcher/Subagents/CitationAgent, delegation discipline).
- Multi-agent token economics: ~15x chat / ~4x single-agent; +90.2% research-eval
  gain; token usage ~80% of score variance.
