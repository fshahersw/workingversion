// ============================================================================
// The multi-agent litigation research loop.
//   router (Opus 4.8)  → sub-agents (Sonnet 5, parallel) → writer (Opus 4.8)
// Emits the SSE event vocabulary the chat UI already renders.
// ============================================================================
import {
  AnthropicError,
  type Msg,
  type ToolDef,
} from "./anthropic.server";
import {
  AGENT_ORDER,
  routerPrompt,
  subAgentPrompt,
  writerPrompt,
  type LitAgentKey,
  type WriterMode,
} from "./prompts";
import {
  BEDROCK_WRITER_MODEL,
  bedrockClaudeEnabled,
  isAnthropicWriter,
  streamWriter,
  type BedrockEffort,
} from "./bedrock-claude.server";
import { AGENT_TOOLS, SourceBook, executeTool } from "./tools.server";
import { agentLog, agentError, since, trunc } from "./log.server";
import {
  FIREWORKS_AGENT_MODEL,
  fireworksChat,
  fireworksEnabled,
  runFireworksToolLoop,
} from "./fireworks.server";
import {
  BEDROCK_AGENT_MODEL,
  bedrockChat,
  bedrockEnabled,
  runBedrockToolLoop,
  userText,
} from "./bedrock.server";

import { parseJsonBlock } from "./json-extract";
import {
  emptyMemory,
  hasContext,
  memoryBlock,
  normalizeMemory,
  resolveQuestion,
  tailMessages,
  updateMemory,
  type SessionMemory,
} from "./memory.server";
import {
  emptyScratchpad,
  mergeScratchpad,
  renderScratchpad,
  type Scratchpad,
} from "./run-state.server";
import { groundCases } from "./grounding.server";
import { runTavilyAngle, tavilyEngineEnabled } from "./tavily.server";



export type Emit = (event: string, data: unknown) => void;

export type HistoryTurn = { role: "user" | "assistant"; content: string };

export type OrchestrateInput = {
  query: string;
  history?: HistoryTurn[];
  /** Maintained session memory (summary, entity ledger, tail, carried sources). */
  memory?: unknown;
  signal?: AbortSignal;
  /** When set, the session is scoped to one matter's corpus/docket. */
  matter?: { matter_id: string; label: string };
};

/**
 * Tools that accept a matter_id filter and should default to the scoped matter.
 * The corpus/registry retrieval tools were removed from the agent workflow, so
 * no exposed tool takes a matter_id today and this set is intentionally empty.
 * Kept as a seam in case matter-scoped tools return.
 */
const MATTER_SCOPED_TOOLS = new Set<string>();

function scopeBlock(input: OrchestrateInput): string {
  if (!input.matter) return "";
  return `MATTER SCOPE\nThe attorney scoped this session to the matter: ${input.matter.label} (matter_id: ${input.matter.matter_id}). Default docket and document searches to this matter unless the question clearly concerns other matters.\n\n`;
}

// Hard safety ceiling on rounds. The router decides when it is DONE (by
// confidence, not a fixed count) — this only stops a runaway loop. Most turns
// still finish in one or two rounds; a genuinely multi-part question may use
// more of the budget.
const MAX_ROUNDS = 3;
/**
 * Tool-loop step cap PER AGENT. docket_research runs on Sonnet (slow per step)
 * and is fed a resolved case_id + docket snapshot by the grounding pre-pass, so
 * 2 steps is plenty — it should read the one filing that matters and write.
 * legal_research runs several parallel searches on fast Nemotron.
 */
const AGENT_STEP_BUDGET: Record<LitAgentKey, number> = {
  // search_authorities fans out to 2-3 gateways inside ONE step, so the extra
  // step that used to exist only to add a second category is gone.
  legal_research: 2,
  docket_research: 2,
};

/** Code-enforced tool-call caps per dispatch (see runBedrockToolLoop.callBudget):
 *  perTool stops hammering one search with near-duplicate queries; total caps
 *  the round. legal_research has 7 distinct tools, so a low perTool forces
 *  variety; docket_research legitimately retries db_search_filings after a
 *  docket-sheet timeout, so its perTool is looser. */
const AGENT_CALL_BUDGET: Record<LitAgentKey, { perTool: number; total: number }> = {
  legal_research: { perTool: 2, total: 6 },
  docket_research: { perTool: 3, total: 6 },
};
/** Hard wall-clock ceiling on the whole research phase (all rounds). Once past
 *  this, stop planning new rounds and write from what has been gathered — no
 *  single question should spend many minutes researching. */
const RESEARCH_BUDGET_MS = 60_000;
/** Parallel {agent, focus} dispatches per round (same agent may appear more
 *  than once with DISTINCT foci — that is how the fan-out gets its width). */
const MAX_DISPATCH = 4;

/** "August 2026" — the recency anchor forced into auto-paired web foci. */
function currentMonthYear(now: Date = new Date()): string {
  return now.toLocaleString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });
}

/**
 * Focus for the legal_research pass auto-paired to a docket dispatch: the same
 * subject, from public authoritative sources, explicitly date-anchored so the
 * newest rulings/news rank first.
 */
function pairedWebFocus(docketFocus: string, question: string): string {
  const subject = (docketFocus || question).replace(/\s+/g, " ").trim().slice(0, 160);
  return `Latest public authoritative sources (rulings, orders, filings coverage, legal news) on: ${subject} — current status as of ${currentMonthYear()}`;
}

/** Tool calls one sub-agent may make per round, and the web-search share of it. */
const AGENT_TOOL_BUDGET = 6;
const AGENT_WEB_BUDGET = 4;

const PLAN_TOOL: ToolDef = {
  name: "plan",
  description: "Record this round's plan. Keep it terse — it is read by machines, not the attorney.",
  input_schema: {
    type: "object",
    properties: {
      phase: {
        type: "string",
        description:
          "A 2-4 word title-case status phrase shown live to the attorney, e.g. 'Locating The Docket', 'Pulling Agency Records'.",
      },
      tier: {
        type: "integer",
        enum: [0, 1, 2, 3],
        description:
          "The effort tier you classified this question as (0 conversational, 1 single lookup, 2 scoped/overview, 3 deep multi-part). Set it every round; it caps how many rounds this question may use.",
      },
      done: {
        type: "boolean",
        description:
          "True when the scratchpad shows the question can now be answered well (confidence high, no material open thread). Decide this from the state, not from a round count.",
      },
      dispatch: {
        type: "array",
        description:
          "Parallel research tasks to run THIS round (up to 4). The same agent MAY appear more than once with DIFFERENT foci — that is how you fan out. No two foci may be near-duplicates. Empty when done is true.",
        items: {
          type: "object",
          properties: {
            agent: { type: "string", enum: AGENT_ORDER },
            focus: { type: "string", description: "ONE short, distinct sub-question for that agent." },
          },
          required: ["agent", "focus"],
        },
      },
      scratchpad: {
        type: "object",
        description:
          "Your running research state. Carry it forward and UPDATE it every round — it is how you reason across rounds.",
        properties: {
          findings: {
            type: "array",
            items: { type: "string" },
            description:
              "Durable facts established so far, terse, each tagged with its [S#] where possible. Add this round's; prior ones are remembered for you.",
          },
          open_threads: {
            type: "array",
            items: { type: "string" },
            description:
              "Sub-questions still unresolved — the agenda that justifies further rounds. Empty this when nothing material is left.",
          },
          confidence: {
            type: "string",
            enum: ["low", "medium", "high"],
            description: "Your confidence that the question can now be answered well from what is gathered.",
          },
          note: { type: "string", description: "One short line: what this round changed / why the next step." },
        },
      },
      reasoning: { type: "string", description: "Optional: one short internal line. Omit it if unsure." },
    },
    required: ["phase", "done", "dispatch"],
  },
};

type Plan = {
  phase: string;
  reasoning: string;
  scratch_note?: string;
  /** Effort tier (0-3) the router classified; caps rounds. Undefined if omitted. */
  tier?: number;
  /** Scratchpad fields the router emitted this round (folded onto carried state). */
  scratch: Partial<Scratchpad>;
  done: boolean;
  dispatch: { agent: LitAgentKey; focus: string }[];
};

/** Keeps the live status phrase to a short, clean 2-4 word label. */
function cleanPhase(v: unknown, fallback = "Reviewing The Question"): string {
  const words = String(v ?? "")
    .replace(/[^\p{L}\p{N}\s'&-]/gu, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 4);
  if (!words.length) return fallback;
  return words
    .map((w) => (w.length > 3 || words.indexOf(w) === 0 ? w[0].toUpperCase() + w.slice(1) : w))
    .join(" ");
}

function parsePlan(input: Record<string, unknown>): Plan {
  const raw = Array.isArray(input["dispatch"]) ? (input["dispatch"] as Record<string, unknown>[]) : [];
  // Keep each {agent, focus} as its own parallel task — the same agent may run
  // several times this round with DIFFERENT foci. Drop only exact/near-duplicate
  // foci for the same agent (a repeated angle wastes a slot), then cap the round.
  const dispatch: { agent: LitAgentKey; focus: string }[] = [];
  const seen = new Set<string>();
  for (const d of raw) {
    const agent = String(d["agent"] ?? "") as LitAgentKey;
    const focus = trunc(String(d["focus"] ?? "").replace(/\s+/g, " ").trim(), 240);
    if (!AGENT_ORDER.includes(agent) || !focus) continue;
    const key = `${agent}:${focus.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    dispatch.push({ agent, focus });
    if (dispatch.length >= MAX_DISPATCH) break;
  }
  const done = Boolean(input["done"]) || dispatch.length === 0;
  const tierRaw = Number(input["tier"]);
  const tier = Number.isInteger(tierRaw) && tierRaw >= 0 && tierRaw <= 3 ? tierRaw : undefined;
  return {
    phase: cleanPhase(input["phase"]),
    reasoning: String(input["reasoning"] ?? "").trim(),
    scratch_note: input["scratch_note"] ? String(input["scratch_note"]) : undefined,
    tier,
    scratch: parseScratch(input["scratchpad"]),
    done,
    dispatch: done ? [] : dispatch,
  };
}

/** Rounds a question of a given tier may use (a hard cap on top of the router's
 *  own done decision). Tier 3 gets the full budget; overviews finish fast. */
function tierRoundCap(tier: number | undefined): number {
  switch (tier) {
    case 0:
    case 1:
      return 1;
    case 2:
      return 2;
    default:
      return MAX_ROUNDS; // tier 3 or unknown
  }
}

/** Pull the router's emitted scratchpad fields (all optional, all defensive). */
function parseScratch(v: unknown): Partial<Scratchpad> {
  if (!v || typeof v !== "object") return {};
  const o = v as Record<string, unknown>;
  const list = (x: unknown): string[] | undefined =>
    Array.isArray(x)
      ? x.map((s) => String(s).replace(/\s+/g, " ").trim()).filter(Boolean).slice(0, 24)
      : undefined;
  const conf = o["confidence"];
  const out: Partial<Scratchpad> = {};
  const findings = list(o["findings"]);
  if (findings) out.findings = findings;
  const open = list(o["open_threads"]);
  if (open) out.openThreads = open;
  if (conf === "low" || conf === "medium" || conf === "high") out.confidence = conf;
  if (typeof o["note"] === "string" && o["note"].trim()) out.note = o["note"].trim();
  return out;
}

/** Bedrock Claude takes plain strings; flatten any block-shaped history turn. */
function flattenMsg(m: Msg): string {
  if (typeof m.content === "string") return m.content;
  return m.content
    .map((b) => (b.type === "text" ? b.text : ""))
    .filter(Boolean)
    .join("\n\n");
}

/** Conservative local tier-0 detector: greetings, thanks and meta questions
 *  about the assistant itself. These never need retrieval, so they skip the
 *  rewrite, the grounding pre-pass and the router entirely. Anything that
 *  smells like a legal question falls through to the normal loop. */
const SMALL_TALK_WORDS = new Set([
  "hi","hey","hello","yo","hiya","greetings","thanks","thank","you","thx","ty","ok","okay",
  "got","it","cool","nice","great","awesome","perfect","sure","yes","no","yep","yup","sounds",
  "good","morning","afternoon","evening","much","appreciate","appreciated","that","helps",
  "how","are","doing","welcome","np","cheers","bye",
]);
const META_ASK =
  /^(who are you|what are you|what can you do|what do you do|what are your capabilities|how do you work|what is this|help)\b[^.?!]*[.?!]?$/i;

function isSmallTalk(query: string): boolean {
  // The client frames every query with a "[Seeger Weiss LLP — ...]" preamble.
  const q = query.replace(/^\s*\[[^\]]*\]\s*/, "").replace(/\s+/g, " ").trim();
  if (!q || q.length > 120) return false;
  if (META_ASK.test(q)) return true;
  const words = q.toLowerCase().replace(/[^a-z\s]/g, " ").split(/\s+/).filter(Boolean);
  if (!words.length || words.length > 8) return false;
  return words.every((w) => SMALL_TALK_WORDS.has(w));
}

export async function runOrchestration(input: OrchestrateInput, emit: Emit): Promise<void> {

  const runId = crypto.randomUUID();
  const runStart = Date.now();
  emit("run", { run_id: runId, query: input.query });
  // Optimistic first frame so the timeline moves during the pre-pass instead of
  // sitting blank. The real round-1 event merges over this by round number.
  emit("round", {
    round: 1,
    phase: "Reviewing The Question",
    reasoning: "",
    done: false,
    dispatch: [],
  });


  const book = new SourceBook();
  const transcript: string[] = [];

  // --- Session memory -------------------------------------------------------
  // The client carries a maintained memory object (rolling summary, entity
  // ledger, verbatim tail, retrieved sources) instead of raw truncated turns.
  let memory: SessionMemory = normalizeMemory(input.memory);
  if (!hasContext(memory) && input.history?.length) {
    // Backwards compatibility: an older client still sending flat history.
    memory = {
      ...memory,
      tail: input.history.slice(-2).map((h) => ({ role: h.role, content: h.content })),
    };
  }

  // Conversational turns (greeting, thanks, "what can you do") need no
  // rewrite, no grounding and no router call — three model round trips saved.
  const smallTalk = isSmallTalk(input.query);

  // Pre-pass, run CONCURRENTLY (these used to be two serial model round trips
  // of dead air before anything reached the screen):
  //   - resolveQuestion rewrites a follow-up into a standalone question.
  //   - groundCases resolves any named case/MDL to a case_id + docket snapshot.
  // Grounding starts on the raw question; if the rewrite materially changed it
  // and grounding found nothing, we retry grounding on the rewritten question.
  const resolveStart = Date.now();
  const groundStart = Date.now();
  const groundPromise = smallTalk
    ? Promise.resolve("")
    : groundCases(input.query, book, input.signal).catch((err) => {
        agentError("grounding_failed", { run: runId, error: trunc(errorMessage(err), 160) });
        return "";
      });
  const [resolved, groundedRaw] = await Promise.all([
    smallTalk
      ? Promise.resolve({ query: input.query, topicShift: false })
      : resolveQuestion(input.query, memory, input.signal),
    groundPromise,
  ]);
  if (resolved.topicShift) {

    // New subject: drop carried state rather than dragging stale matters in.
    memory = { ...emptyMemory(), turns: memory.turns };
  }
  if (resolved.query !== input.query || resolved.topicShift) {
    agentLog("memory_resolve", {
      run: runId,
      ms: since(resolveStart),
      topic_shift: resolved.topicShift,
      q: trunc(resolved.query, 160),
    });
  }

  const researchInput: OrchestrateInput = { ...input, query: resolved.query };
  const memBlock = memoryBlock(memory);
  const history: Msg[] = tailMessages(memory).map((h) => ({
    role: h.role,
    content: h.content,
  }));

  // Sources already retrieved this session keep their refs and are reused.
  book.seed(memory.sources);
  const carried = book.all().length;

  agentLog("run_start", {
    run: runId,
    q: trunc(input.query, 200),
    history_turns: history.length,
    mem_entities: memory.entities.length,
    carried_sources: carried,
  });

  let groundBlock = groundedRaw;
  if (!groundBlock && resolved.query !== input.query) {
    // The rewrite may have surfaced the case name the raw follow-up hid.
    // groundCases self-gates cheaply when no case is named, so this is safe.
    try {
      groundBlock = await groundCases(resolved.query, book, input.signal);
    } catch (err) {
      agentError("grounding_failed", { run: runId, error: trunc(errorMessage(err), 160) });
    }
  }
  agentLog("prepass", { run: runId, ms: since(groundStart), grounded: Boolean(groundBlock) });
  if (groundBlock) {
    emit("sources", { sources: book.all() });
  }
  // What the router and sub-agents see: session memory + any resolved case context.
  const contextBlock = [memBlock, groundBlock].filter(Boolean).join("\n\n---\n\n");


  // Experimental engine switch: RESEARCH_ENGINE=tavily replaces the AgentCore
  // gateways AND the DocketBird tool loop with one Tavily advanced search per
  // research angle (see tavily.server.ts for the trade-off).
  const tavilyEngine = tavilyEngineEnabled();
  const tavilySeen = new Set<string>();
  const tavilyAnswers: string[] = [];
  if (tavilyEngine) agentLog("engine", { run: runId, engine: "tavily" });

  let round = 0;
  let dispatchedAgents = 0;
  let routerMs = 0;
  let agentsMs = 0;
  // The router's running state, carried and updated round over round.
  let scratchpad: Scratchpad = emptyScratchpad();
  let unproductiveStreak = 0;
  // Effort tier the router classified (from round 1); caps how many rounds run.
  let effortTier: number | undefined;
  // Every (agent, focus) already dispatched, to force escalation over repetition.
  const triedFoci = new Set<string>();
  const focusKey = (agent: string, focus: string) =>
    `${agent}::${focus.toLowerCase().replace(/\s+/g, " ").trim()}`;
  try {
    if (smallTalk) {
      // Straight to the writer in conversational mode.
      agentLog("fast_path", { run: runId, reason: "small_talk", q: trunc(input.query, 120) });
      emit("round", {
        round: 1,
        phase: "Answering Directly",
        reasoning: "",
        done: true,
        dispatch: [],
      });
      round = 0;
    }
    for (round = smallTalk ? 0 : 1; round >= 1 && round <= MAX_ROUNDS; round++) {

      const routerStart = Date.now();
      const plan = await planRound(
        researchInput,
        contextBlock,
        history,
        transcript,
        scratchpad,
        round,
        book.all().length,
      );
      // Fold this round's emitted state onto the carried scratchpad.
      scratchpad = mergeScratchpad(scratchpad, plan.scratch);
      // Lock in the tier from the first round that reports one.
      if (effortTier === undefined && plan.tier !== undefined) effortTier = plan.tier;

      // Escalation, not repetition: drop any focus already tried in an earlier
      // round. If nothing new is left to try, the router is looping on threads
      // it cannot close — finish rather than burn the remaining rounds.
      if (!plan.done && plan.dispatch.length) {
        const fresh = plan.dispatch.filter((d) => {
          const key = focusKey(d.agent, d.focus);
          if (triedFoci.has(key)) return false;
          triedFoci.add(key);
          return true;
        });
        if (fresh.length < plan.dispatch.length) {
          agentLog("dedupe_foci", {
            run: runId,
            round,
            dropped: plan.dispatch.length - fresh.length,
          });
        }
        if (!fresh.length) {
          agentLog("early_exit", { run: runId, round, reason: "no_new_foci" });
          plan.dispatch = [];
          plan.done = true;
        } else {
          plan.dispatch = fresh;
        }
      }

      // NEVER A DOCKET-ONLY ROUND. DocketBird can miss a case, throttle a large
      // docket, or return nothing — a round that only asked the docket then
      // answers "I could not find it". Any round touching docket_research gets
      // a parallel, date-anchored legal_research pass on the same subject, so
      // the writer always has authoritative web sources to answer from. Runs in
      // the same Promise.all fan-out, so it costs no extra wall-clock time.
      // (Not needed on the Tavily engine: every dispatch there IS a web search.)
      if (!tavilyEngine && !plan.done && plan.dispatch.length && plan.dispatch.length < MAX_DISPATCH) {
        const hasDocket = plan.dispatch.some((d) => d.agent === "docket_research");
        const hasWeb = plan.dispatch.some((d) => d.agent === "legal_research");
        if (hasDocket && !hasWeb) {
          const docketFocus =
            plan.dispatch.find((d) => d.agent === "docket_research")?.focus ?? researchInput.query;
          const focus = pairedWebFocus(docketFocus, researchInput.query);
          const key = focusKey("legal_research", focus);
          if (!triedFoci.has(key)) {
            triedFoci.add(key);
            plan.dispatch.push({ agent: "legal_research", focus });
            agentLog("forced_pair", { run: runId, round, focus: trunc(focus, 140) });
          }
        }
      }



      const thisRouterMs = since(routerStart);
      routerMs += thisRouterMs;
      agentLog("router", {
        run: runId,
        round,
        ms: thisRouterMs,
        done: plan.done,
        dispatch: plan.dispatch.map((d) => d.agent).join(",") || "-",
        confidence: scratchpad.confidence,
        open_threads: scratchpad.openThreads.length,
        sources_so_far: book.all().length,
      });
      for (const d of plan.dispatch) {
        agentLog("dispatch", { run: runId, round, agent: d.agent, focus: trunc(d.focus, 140) });
      }
      emit("round", {
        round,
        phase: plan.phase,
        reasoning: plan.reasoning,
        scratch_note: scratchpad.note || plan.scratch_note,
        done: plan.done,
        dispatch: plan.dispatch,
      });
      if (plan.done) break;

      dispatchedAgents += plan.dispatch.length;
      const agentsStart = Date.now();
      const outcomes = await Promise.all(
        plan.dispatch.map(async (d) => {
          emit("agent", { round, agent: d.agent, focus: d.focus, status: "start" });
          const agentStart = Date.now();
          // Tavily engine: the dispatch focus IS the search query — one advanced
          // Tavily call with an included answer, no sub-agent model turn.
          const digest = tavilyEngine
            ? await (async () => {
                emit("tool_call", { round, agent: d.agent, tool: "tavily_search", query: d.focus });
                const angle = await runTavilyAngle({
                  focus: d.focus,
                  question: researchInput.query,
                  book,
                  seen: tavilySeen,
                  runId,
                  ...(input.signal ? { signal: input.signal } : {}),
                });
                if (angle.answer) tavilyAnswers.push(angle.answer);
                emit("tool_call", {
                  round,
                  agent: d.agent,
                  tool: "tavily_search",
                  query: d.focus,
                  hits: angle.hits,
                });
                emit("sources", { sources: book.all() });
                return {
                  summary: angle.digest,
                  count: angle.hits,
                  refs: angle.refs,
                  ...(angle.failed ? { failed: true as const } : {}),
                };
              })()
            : await runSubAgent(d.agent, d.focus, researchInput, contextBlock, book, round, emit, runId);
          transcript.push(`### Round ${round} — ${d.agent}\nFocus: ${d.focus}\n${digest.summary}`);
          const logFields = {
            run: runId,
            round,
            agent: d.agent,
            ms: since(agentStart),
            hits: digest.count,
            citations: digest.refs.length,
            digest_chars: digest.summary.length,
          };
          if (digest.failed) {
            agentError("agent_failed", { ...logFields, error: trunc(digest.summary, 200) });
          } else {
            agentLog("agent_done", logFields);
          }
          emit("agent_done", {
            round,
            agent: d.agent,
            summary: digest.summary,
            count: digest.count,
            citations: digest.refs,
          });
          return digest;
        }),
      );
      agentsMs += since(agentsStart);


      // The router owns "done" — driven by its scratchpad confidence, not a
      // fixed round count. The only hard guard here is anti-runaway: if two
      // rounds in a row add nothing (every agent empty/failed, e.g. a provider
      // outage), stop rather than burning the remaining budget on dead ends.
      const productive = outcomes.filter((o) => !o.failed && o.count > 0).length;
      unproductiveStreak = productive ? 0 : unproductiveStreak + 1;
      if (unproductiveStreak >= 2) {
        agentLog("early_exit", { run: runId, round, reason: "two_unproductive_rounds" });
        break;
      }
      // Wall-clock guard: never let the research phase run away. Past the
      // budget, stop planning more rounds and write from what is gathered.
      if (Date.now() - runStart > RESEARCH_BUDGET_MS) {
        agentLog("early_exit", { run: runId, round, reason: "research_budget", ms: since(runStart) });
        break;
      }
      // Tier round cap: an overview (tier 2) or lookup (tier 1) does not get to
      // keep chasing details across many rounds, whatever the router's confidence.
      if (round >= tierRoundCap(effortTier)) {
        agentLog("early_exit", { run: runId, round, reason: "tier_round_cap", tier: effortTier });
        break;
      }
    }

    const sources = book.all();
    emit("sources", { sources });
    emit("writer_start", { round, sources: sources.length });
    agentLog("writer_start", { run: runId, round, sources: sources.length });
    if (!sources.length) {
      agentError("no_sources", { run: runId, round, q: trunc(input.query, 200) });
    }

    const writerStart = Date.now();
    let answerChars = 0;
    let answerText = "";

    // Depth is inferred from what the research actually did, so a light turn
    // gets a conversational reply and a multi-round turn gets full synthesis.
    const mode: WriterMode =
      dispatchedAgents === 0 && sources.length === 0
        ? "conversational"
        : dispatchedAgents > 1 || round > 1 || sources.length > 8
          ? "deep"
          : "scoped";
    // Output caps sized for a fact-stating writer (GLM path spends the whole
    // budget on visible text; the Anthropic fallback path still floors at 8k
    // internally because thinking shares the budget there).
    const writerBudget =
      mode === "conversational" ? 3000 : mode === "scoped" ? 6000 : 9000;
    // Final writer reasoning effort is capped at medium (deep no longer uses
    // high) — it keeps the long token budget but cuts the adaptive-thinking
    // latency that pushed deep answers past a minute.
    const writerEffort: BedrockEffort =
      mode === "conversational" ? "low" : "medium";

    const writerUser = [
      memBlock ? `SESSION CONTEXT (background only — do not restate it)\n${memBlock}` : "",
      `QUESTION\n${input.query}`,
      resolved.query !== input.query ? `The question refers to: ${resolved.query}` : "",
      `RESEARCH DIGESTS\n${transcript.join("\n\n") || "No agent produced findings."}`,
      `SOURCES\n${
        sources
          .map(
            (s) =>
              `[${s.ref}] ${s.citation}${s.source_url ? ` — ${s.source_url}` : ""}` +
              ` (${s.effective_date ? `as of ${String(s.effective_date).slice(0, 10)}` : "date unknown"})` +
              `${s.is_current === false ? " [SUPERSEDED — a newer source on this subject is listed; prefer it]" : ""}\n${s.content}`,
          )
          .join("\n\n") ||
        "(none — answer from general mass tort practice, without citation markers and without narrating that sources are absent)"
      }`,
      "Write the answer now.",
    ]
      .filter(Boolean)
      .join("\n\n---\n\n");

    const onWriterText = (text: string) => {
      answerChars += text.length;
      answerText += text;
      emit("delta", { text });
    };

    // FAST PATH (Tavily engine only): a tier 0/1 lookup answered by a single
    // Tavily angle is returned as Tavily's own grounded answer — no writer turn.
    const directAnswer =
      tavilyEngine &&
      !smallTalk &&
      effortTier !== undefined &&
      effortTier <= 1 &&
      tavilyAnswers.length === 1 &&
      (tavilyAnswers[0] ?? "").length > 80
        ? (tavilyAnswers[0] as string)
        : "";

    let writerVia = isAnthropicWriter(BEDROCK_WRITER_MODEL) ? "bedrock_sonnet5" : "bedrock_converse";
    let bedrockWriterFailed = "";
    if (directAnswer) {
      writerVia = "tavily_answer";
      const refLine = sources.length
        ? `\n\nSources: ${sources.map((s) => `[${s.ref}]`).join(" ")}`
        : "";
      // Emitted in chunks so the UI renders it progressively, like a stream.
      for (let i = 0; i < directAnswer.length; i += 240) {
        onWriterText(directAnswer.slice(i, i + 240));
      }
      if (refLine) onWriterText(refLine);
      agentLog("writer_fast_path", { run: runId, tier: effortTier, chars: answerChars });
    } else if (bedrockClaudeEnabled()) {
      try {
        const out = await streamWriter(
          {
            model: BEDROCK_WRITER_MODEL,
            system: writerPrompt(mode),
            messages: [
              ...history.map((h) => ({ role: h.role, content: flattenMsg(h) })),
              { role: "user" as const, content: writerUser },
            ],
            maxTokens: writerBudget,
            effort: writerEffort,
            ...(input.signal ? { signal: input.signal } : {}),
          },
          { onText: onWriterText },
        );
        agentLog("writer_model", {
          run: runId,
          model: BEDROCK_WRITER_MODEL,
          mode,
          effort: writerEffort,
          thinking_tokens: out.thinkingTokens,
        });
      } catch (err) {
        bedrockWriterFailed = trunc(errorMessage(err), 200);
        // Never restart a half-written answer — only fall back before any token.
        if (answerChars > 0) throw err;
      }
    } else {
      bedrockWriterFailed = "AWS_BEARER_TOKEN_BEDROCK not configured";
    }


    if (bedrockWriterFailed && answerChars === 0) {
      // No Anthropic fallback — surface the Bedrock provider failure clearly.
      agentError("writer_unavailable", { run: runId, round, error: bedrockWriterFailed });
      throw new Error(`Writer unavailable: ${bedrockWriterFailed}`);
    }
    const writerMs = since(writerStart);
    agentLog("writer_done", { run: runId, via: writerVia, mode, ms: writerMs, chars: answerChars });


    emit("done", { run_id: runId, status: "complete", rounds: round, source_count: sources.length });
    agentLog("run_done", {
      run: runId,
      status: "complete",
      rounds: round,
      sources: sources.length,
      answer_chars: answerChars,
      router_ms: routerMs,
      agents_ms: agentsMs,
      writer_ms: writerMs,
      total_ms: since(runStart),
    });

    // Refresh the session memory AFTER the turn is marked done — the answer is
    // already complete, so this model call must not sit on the critical path.
    // The client applies the memory event whenever it arrives.
    const nextMemory = await updateMemory(
      memory,
      input.query,
      answerText,
      sources,
      input.signal,
    );
    emit("memory", { memory: nextMemory });

  } catch (err) {
    const status = err instanceof AnthropicError ? err.status : undefined;
    agentError("run_failed", {
      run: runId,
      round,
      http: status,
      total_ms: since(runStart),
      error: trunc(errorMessage(err), 240),
    });
    emit("error", { message: errorMessage(err) });
  }
}


async function planRound(
  input: OrchestrateInput,
  memBlock: string,
  history: Msg[],
  transcript: string[],
  scratchpad: Scratchpad,
  round: number,
  sourceCount: number,
): Promise<Plan> {
  const state = transcript.length
    ? `RESEARCH SO FAR (${sourceCount} sources collected)\n\n${transcript.join("\n\n")}`
    : "No research has run yet. This is round 1.";
  const roundLine =
    round === 1
      ? `This is round 1 (you may use up to ${MAX_ROUNDS} rounds, but decide DONE by confidence — most turns need far fewer).`
      : `This is round ${round} of at most ${MAX_ROUNDS}. Continue ONLY to close a still-open thread; otherwise set done: true.`;
  const userContent = `${scopeBlock(input)}${memBlock ? `${memBlock}\n\n---\n\n` : ""}QUESTION\n${input.query}\n\n---\n\n${renderScratchpad(scratchpad)}\n\n---\n\n${state}\n\n${roundLine}`;

  // Preferred: Nemotron on AWS Bedrock plans the round.
  if (bedrockEnabled()) {
    try {
      const res = await bedrockChat({
        model: BEDROCK_AGENT_MODEL,
        system: routerPrompt(),
        messages: [
          ...history.map((h) => ({
            role: h.role,
            content: [{ text: typeof h.content === "string" ? h.content : "" }],
          })),
          userText(userContent),
        ],
        tools: [PLAN_TOOL],
        toolChoice: { name: "plan" },
        // Tight budget: the plan is a phase, a tier, a done flag and up to four
        // short foci. Every extra token of scratchpad prose is pure latency.
        maxTokens: 1500,
        temperature: 0.1,
        ...(input.signal ? { signal: input.signal } : {}),
      });
      const call = res.toolCalls.find((t) => t.name === "plan");
      const plan = call ? parsePlan(call.input) : null;
      const fallbackPlan = plan ?? (() => {
        const parsed = parseJsonBlock(res.text, "dispatch");
        return parsed ? parsePlan(parsed) : null;
      })();
      // A round-1 plan with nothing to dispatch means the model ignored the
      // agent enum — let the next provider plan instead of skipping research.
      if (fallbackPlan && !(round === 1 && fallbackPlan.dispatch.length === 0)) {
        return fallbackPlan;
      }

    } catch (err) {
      agentError("router_bedrock_fallback", { round, error: trunc(errorMessage(err), 200) });
    }
  }

  // Fallback: Kimi K3 on Fireworks plans the round. Claude is the last resort.

  if (fireworksEnabled()) {
    try {
      const res = await fireworksChat({
        model: FIREWORKS_AGENT_MODEL,
        messages: [
          { role: "system", content: routerPrompt() },
          ...history.map((h) => ({
            role: h.role,
            content: typeof h.content === "string" ? h.content : "",
          })),
          { role: "user" as const, content: userContent },
        ],
        tools: [PLAN_TOOL],
        toolChoice: { name: "plan" },
        maxTokens: 4000,
        ...(input.signal ? { signal: input.signal } : {}),
      });
      const call = res.toolCalls.find((t) => t.name === "plan");
      if (call) return parsePlan(call.input);
      const parsed = parseJsonBlock(res.text, "dispatch");
      if (parsed) return parsePlan(parsed);
    } catch (err) {
      agentError("router_fallback", { round, error: trunc(errorMessage(err), 200) });
    }
  }

  // No Anthropic fallback. If Bedrock (and Fireworks) are both unavailable,
  // proceed to the writer with an empty plan; the writer surfaces the provider
  // error if Bedrock is truly down.
  return {
    phase: "Drafting The Answer",
    reasoning: "",
    scratch: {},
    done: true,
    dispatch: [],
  };
}

async function runSubAgent(
  agent: LitAgentKey,
  focus: string,
  input: OrchestrateInput,
  memBlock: string,
  book: SourceBook,
  round: number,
  emit: Emit,
  runId: string,
): Promise<{ summary: string; count: number; refs: string[]; failed?: boolean }> {
  const refs = new Set<string>();
  let hits = 0;

  let userContent = `${scopeBlock(input)}${memBlock ? `${memBlock}\n\n---\n\n` : ""}ATTORNEY'S QUESTION (context only)\n${input.query}\n\nYOUR FOCUS THIS ROUND\n${focus}\n\nResearch it, then write your digest.`;

  // Pre-load the docket sheet when the grounding pre-pass resolved a case but
  // could not snapshot it ("too large/slow"). Saves a full model turn — the
  // agent goes straight from turn 1 to reading filings and writing.
  if (agent === "docket_research" && memBlock.includes("too large/slow to snapshot")) {
    const caseId = /case_id:\s*(\d+)/.exec(memBlock)?.[1];
    if (caseId) {
      try {
        const sheet = await executeTool(
          "db_docket_sheet",
          { case_id: caseId, limit: 20, ...(input.matter ? { matter_id: input.matter.matter_id } : {}) },
          book,
        );
        if (sheet.hits > 0) {
          hits += sheet.hits;
          sheet.refs.forEach((r) => refs.add(r));
          userContent += `\n\n---\n\nDOCKET SNAPSHOT (pre-loaded for case_id ${caseId} — do NOT call db_docket_sheet for this case unless you need entries beyond these)\n${sheet.text}`;
          agentLog("docket_preload", { run: runId, round, case_id: caseId, hits: sheet.hits });
        }
      } catch {
        /* best effort — the agent can still call db_docket_sheet itself */
      }
    }
  }

  const announce = (call: { name: string; input: Record<string, unknown> }) => {
    emit("tool_call", {
      round,
      agent,
      tool: call.name,
      query: typeof call.input["query"] === "string" ? call.input["query"] : undefined,
      scope: typeof call.input["scope"] === "string" ? call.input["scope"] : undefined,
    });
  };

  // Per-round tool budget: agents otherwise sweep 8+ near-identical searches.
  let toolCalls = 0;
  let webCalls = 0;
  // Two consecutive db_find_case misses means the case is not in the index —
  // short-circuit instead of letting the agent burn its whole budget on absence.
  let findCaseMisses = 0;

  const execute = async (call: { name: string; input: Record<string, unknown> }) => {
    const toolStart = Date.now();
    const isWeb = call.name === "web_search";
    if (toolCalls >= AGENT_TOOL_BUDGET || (isWeb && webCalls >= AGENT_WEB_BUDGET)) {
      agentLog("tool_budget", { run: runId, round, agent, tool: call.name, calls: toolCalls });
      return "Tool budget reached for this round — write your digest now from what you already have.";
    }
    toolCalls++;
    if (isWeb) webCalls++;
    const q = typeof call.input["query"] === "string" ? call.input["query"] : undefined;
    // Matter-scoped sessions default docket/document searches to the scope.
    let args = call.input;
    if (input.matter && MATTER_SCOPED_TOOLS.has(call.name)) {
      const mid = args["matter_id"];
      if (typeof mid !== "string" || !mid.trim()) {
        args = { ...args, matter_id: input.matter.matter_id };
      }
    }
    try {
      const out = await executeTool(call.name, args, book);
      hits += out.hits;
      out.refs.forEach((r) => refs.add(r));
      agentLog("tool", {
        run: runId,
        round,
        agent,
        tool: call.name,
        q: q ? trunc(q, 120) : undefined,
        hits: out.hits,
        ms: since(toolStart),
      });
      emit("tool_call", { round, agent, tool: call.name, query: q, hits: out.hits });
      if (call.name === "db_find_case") {
        findCaseMisses = out.hits > 0 ? 0 : findCaseMisses + 1;
        if (findCaseMisses >= 2) {
          agentLog("find_case_terminal", { run: runId, round, agent });
          return `TERMINAL: db_find_case has now returned no usable case twice. STOP calling it — this case is not in the docket index. Write your digest from what you already have (state the absence explicitly), and leave broader court coverage to legal_research.\n\n${out.text}`;
        }
      }
      return out.text;
    } catch (err) {
      agentError("tool_failed", {
        run: runId,
        round,
        agent,
        tool: call.name,
        q: q ? trunc(q, 120) : undefined,
        ms: since(toolStart),
        error: trunc(errorMessage(err), 200),
      });
      throw err;
    }
  };

  // Model per agent. docket_research needs a capable tool-caller to read the
  // resolved docket and synthesize; it defaults to Sonnet 5 but can be swapped
  // to any Bedrock model (e.g. Claude Haiku 4.5, "us.anthropic.claude-haiku-4-5")
  // via the BEDROCK_DOCKET_MODEL env var for cheaper/faster A/B — no code change.
  // legal_research does parallel independent searches Nemotron handles well.
  const subModel =
    agent === "docket_research"
      ? process.env["BEDROCK_DOCKET_MODEL"] || BEDROCK_AGENT_MODEL
      : BEDROCK_AGENT_MODEL;

  // Preferred: AWS Bedrock runs the research pass (Sonnet 5 for docket, Nemotron otherwise).
  if (bedrockEnabled()) {
    try {
      agentLog("sub_model", { run: runId, round, agent, model: subModel });
      const { text } = await runBedrockToolLoop({
        model: subModel,
        system: subAgentPrompt(agent),
        user: userContent,
        tools: AGENT_TOOLS[agent],
        // Nothing downstream consumes more than a few hundred characters of
        // digest — a 12k ceiling only invited 15s+ of narration per turn.
        maxTokens: 2500,
        maxSteps: AGENT_STEP_BUDGET[agent] ?? 4,
        callBudget: AGENT_CALL_BUDGET[agent] ?? { perTool: 2, total: 6 },
        // Wall-clock cap per dispatch: a slow provider turn must not eat the
        // whole research budget. Checked between turns, never mid-call.
        deadlineMs: 28_000,
        // Haiku 4.5 and Nemotron accept temperature; 5-gen Sonnet/Opus reject it.
        ...(subModel === BEDROCK_AGENT_MODEL ? { temperature: 0 } : {}),
        ...(input.signal ? { signal: input.signal } : {}),
        onStep: (s) =>
          agentLog("agent_step", {
            run: runId,
            round,
            agent,
            step: s.step,
            ms: s.ms,
            stop: s.stopReason,
            in: s.inputTokens,
            out: s.outputTokens,
            calls: s.toolCalls.join(",") || "-",
          }),
        onToolUse: announce,
        execute,
      });
      if (text.trim()) return { summary: text, count: hits, refs: [...refs] };
    } catch (err) {
      agentError("agent_bedrock_fallback", {
        run: runId,
        round,
        agent,
        error: trunc(errorMessage(err), 200),
      });
    }
  }

  // Fallback: Kimi K3 on Fireworks; Claude covers any failure after that.
  if (fireworksEnabled()) {

    try {
      const { text } = await runFireworksToolLoop({
        model: FIREWORKS_AGENT_MODEL,
        system: subAgentPrompt(agent),
        user: userContent,
        tools: AGENT_TOOLS[agent],
        maxTokens: 2500,
        maxSteps: AGENT_STEP_BUDGET[agent] ?? 4,
        ...(input.signal ? { signal: input.signal } : {}),
        onToolUse: announce,
        execute,
      });
      if (text.trim()) return { summary: text, count: hits, refs: [...refs] };
    } catch (err) {
      agentError("agent_fallback", { run: runId, round, agent, error: trunc(errorMessage(err), 200) });
    }
  }

  // No Anthropic fallback — Bedrock (Nemotron) and Fireworks are the only
  // sub-agent providers. If neither ran, report a failed pass.
  return {
    summary: "Research agent unavailable (no model provider succeeded this round).",
    count: hits,
    refs: [...refs],
    failed: true,
  };
}

function errorMessage(err: unknown): string {
  if (err instanceof AnthropicError) return err.message;
  if (err instanceof Error) return err.message;
  return "Research failed.";
}
