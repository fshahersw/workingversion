// ============================================================================
// Bounded multi-round research loop (§28) + parallel tool executor (§29/§42).
//
// The model decides WHAT (an OrchestratorDecision); this runtime decides HOW:
// deterministic parallelism, per-call timeouts, duplicate-call elimination, and
// a hard round ceiling. A model never self-authorizes unlimited rounds.
//
// Model-agnostic by construction: the reasoning model is injected as an
// `Orchestrator` port and the tools as a `ToolRunner` port. Grok implements the
// orchestrator later; the existing tool registry implements the runner. Tests
// drive both with fakes — no model or network needed.
//
// Server module: the fingerprint uses node:crypto.
// ============================================================================
import type {
  ChoicePanel,
  OrchestratorDecision,
  ToolCallSpec,
  ToolRunResult,
} from "./frontier-contracts.ts";
import { callFingerprint } from "./frontier-fingerprint.server.ts";
import { ResearchState } from "./frontier-research-state.ts";

/** The reasoning model's per-round decision maker (§8/§9). */
export interface Orchestrator {
  decide(state: ResearchState, signal?: AbortSignal): Promise<OrchestratorDecision>;
}

/** Executes a single tool call and normalizes the result (§11). Must resolve
 *  (never reject) — surface failure as ok:false. */
export interface ToolRunner {
  run(call: ToolCallSpec, signal?: AbortSignal): Promise<ToolRunResult>;
}

/** Thrown to pause the request for a user choice-panel selection (§33/§34).
 *  The controller catches this, emits the panel, and resumes on selection. */
export class ChoiceRequired extends Error {
  readonly panel: ChoicePanel;
  constructor(panel: ChoicePanel) {
    super("user choice required");
    this.name = "ChoiceRequired";
    this.panel = panel;
  }
}

export interface ExecuteOptions {
  /** §29: start at 4-6 concurrent external calls per request. */
  maxConcurrency?: number;
  /** Per-call wall-clock cap; on timeout the call yields ok:false. */
  perCallTimeoutMs?: number;
  /** Shared across rounds so a fingerprint seen earlier is reused (§42). */
  cache?: Map<string, Promise<ToolRunResult>>;
  signal?: AbortSignal;
  onToolStart?: (call: ToolCallSpec) => void;
  onToolResult?: (result: ToolRunResult) => void;
}

const DEFAULT_CONCURRENCY = 5;
const DEFAULT_TIMEOUT_MS = 15_000;

function errorResult(call: ToolCallSpec, error: string): ToolRunResult {
  return { callId: call.id, tool: call.tool, ok: false, evidence: [], error };
}

/** Run one call with a timeout + error guard. Always resolves. */
async function runOne(
  runner: ToolRunner,
  call: ToolCallSpec,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<ToolRunResult> {
  if (signal?.aborted) return errorResult(call, "aborted");
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<ToolRunResult>((resolve) => {
    timer = setTimeout(() => resolve(errorResult(call, `timeout after ${timeoutMs}ms`)), timeoutMs);
  });
  try {
    const res = await Promise.race([
      runner.run(call, signal).catch((err) =>
        errorResult(call, err instanceof Error ? err.message : "tool failed"),
      ),
      timeout,
    ]);
    return res;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Execute a decision's calls with bounded concurrency and duplicate-call
 * elimination. Identical (tool, canonical args) fingerprints share one
 * execution; the shared `cache` also reuses results across rounds. Each call in
 * the batch gets a result carrying its own callId, even when it deduped onto
 * another call's execution.
 */
export async function parallelExecute(
  runner: ToolRunner,
  calls: readonly ToolCallSpec[],
  opts: ExecuteOptions = {},
): Promise<ToolRunResult[]> {
  const cache = opts.cache ?? new Map<string, Promise<ToolRunResult>>();
  const limit = Math.max(1, opts.maxConcurrency ?? DEFAULT_CONCURRENCY);
  const timeoutMs = opts.perCallTimeoutMs ?? DEFAULT_TIMEOUT_MS;

  const fingerprints = calls.map((c) => callFingerprint(c.tool, c.args));

  // Unique fingerprints not already cached become scheduled tasks.
  const pending: Array<{ fp: string; call: ToolCallSpec }> = [];
  const resolvers = new Map<string, (r: ToolRunResult) => void>();
  fingerprints.forEach((fp, i) => {
    if (cache.has(fp) || resolvers.has(fp)) return;
    cache.set(fp, new Promise<ToolRunResult>((resolve) => resolvers.set(fp, resolve)));
    pending.push({ fp, call: calls[i]! });
  });

  // Drain the pending queue with a fixed concurrency gate.
  let active = 0;
  let next = 0;
  const pump = (): void => {
    while (next < pending.length && active < limit) {
      const { fp, call } = pending[next++]!;
      active++;
      opts.onToolStart?.(call);
      void runOne(runner, call, timeoutMs, opts.signal).then((res) => {
        resolvers.get(fp)!(res);
        opts.onToolResult?.(res);
        active--;
        pump();
      });
    }
  };
  pump();

  // Await in call order; re-stamp the callId so a deduped call keeps its id.
  const results: ToolRunResult[] = [];
  for (let i = 0; i < calls.length; i++) {
    const res = await cache.get(fingerprints[i]!)!;
    results.push({ ...res, callId: calls[i]!.id });
  }
  return results;
}

export interface ResearchLoopOptions {
  maxConcurrency?: number;
  perCallTimeoutMs?: number;
  signal?: AbortSignal;
  onProgress?: (label: string) => void;
  onToolStart?: (call: ToolCallSpec) => void;
  onToolResult?: (result: ToolRunResult) => void;
}

/**
 * Bounded research loop (§28). Each round the orchestrator inspects the state
 * and decides: request a user choice (pause), stop (complete/handoff), or emit
 * a tool batch. Batches execute in parallel with dedup; the state re-ranks and
 * re-scores coverage; the loop stops early when required coverage is met, and
 * always stops at route.maxResearchRounds. Returns the EvidenceBundle.
 */
export async function researchLoop(
  state: ResearchState,
  orchestrator: Orchestrator,
  runner: ToolRunner,
  opts: ResearchLoopOptions = {},
): Promise<ReturnType<ResearchState["bundle"]>> {
  const maxRounds = state.route.maxResearchRounds;
  if (maxRounds < 1) return state.bundle();

  const cache = new Map<string, Promise<ToolRunResult>>();

  for (let round = 1; round <= maxRounds; round++) {
    if (opts.signal?.aborted) break;
    state.round = round;
    opts.onProgress?.(round === 1 ? "Planning research" : "Checking remaining evidence gaps");

    const decision = await orchestrator.decide(state, opts.signal);

    if (decision.status === "request_user_choice") {
      if (!decision.choicePanel) throw new Error("orchestrator requested a choice with no panel");
      throw new ChoiceRequired(decision.choicePanel);
    }
    if (decision.status === "complete" || decision.status === "handoff_to_writer") break;

    const calls = decision.calls ?? [];
    if (!calls.length) break;

    const results = await parallelExecute(runner, calls, {
      cache,
      ...(opts.maxConcurrency !== undefined ? { maxConcurrency: opts.maxConcurrency } : {}),
      ...(opts.perCallTimeoutMs !== undefined ? { perCallTimeoutMs: opts.perCallTimeoutMs } : {}),
      ...(opts.signal ? { signal: opts.signal } : {}),
      ...(opts.onToolStart ? { onToolStart: opts.onToolStart } : {}),
      ...(opts.onToolResult ? { onToolResult: opts.onToolResult } : {}),
    });

    state.add(results);
    state.dedupeAndRank();
    state.updateCoverage();

    if (state.isComplete()) break;
  }

  return state.bundle();
}
