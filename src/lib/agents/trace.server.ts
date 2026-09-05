// ============================================================================
// In-memory run trace collector — server-only observability for the Run
// Inspector (dev surface). It TAPS agentLog(): every structured log line the
// agent already emits carries `run=<id>` plus rich per-step detail (ms, token
// cache read/write, tool calls, coverage gate, verification + faithfulness
// counts), so we reconstruct a full per-run timeline with ZERO changes to the
// agent loop itself.
//
// Bounded (a small ring of recent runs, capped events per run) so it can never
// leak memory, and gated OFF in production unless AGENT_TRACE=1. No persistence,
// no new AWS infra. Fields are already truncated by the logger before we see a
// string, and we never store source bodies or credentials.
// ============================================================================
import type { Fields } from "./log.server";

export type TraceEvent = {
  /** ms since this run's first event. */
  at: number;
  stage: string;
  level: "log" | "error";
  fields: Fields;
};

export type RunTrace = {
  run: string;
  startedAt: number; // epoch ms
  events: TraceEvent[];
};

/** Derived, UI-friendly one-line view of a run. */
export type RunSummary = {
  run: string;
  startedAt: number;
  engine?: string;
  mode?: string;
  status: "running" | "complete" | "error";
  query?: string;
  totalMs?: number;
  steps?: number;
  toolCalls?: number;
  sources?: number;
  answerChars?: number;
  gateRequeried?: boolean;
  faith?: { checked: number; supported: number; unsupported: number };
  verify?: { checked: number; verified: number };
  error?: string;
  events: number;
};

const MAX_RUNS = 60;
const MAX_EVENTS_PER_RUN = 240;

// Insertion-ordered map: first key is the oldest run (evicted first).
const runs = new Map<string, RunTrace>();

function enabled(): boolean {
  return process.env["NODE_ENV"] !== "production" || process.env["AGENT_TRACE"] === "1";
}

function num(v: unknown): number | undefined {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  return Number.isFinite(n) ? n : undefined;
}
function str(v: unknown): string | undefined {
  return typeof v === "string" && v.length ? v : undefined;
}

/** Tapped by agentLog / agentError. Cheap, never throws, no-op unless enabled. */
export function recordTrace(stage: string, fields: Fields, level: "log" | "error"): void {
  if (!enabled()) return;
  const run = str(fields["run"]);
  if (!run) return; // only run-attributed events belong on a timeline
  try {
    let trace = runs.get(run);
    const now = Date.now();
    if (!trace) {
      trace = { run, startedAt: now, events: [] };
      runs.set(run, trace);
      while (runs.size > MAX_RUNS) {
        const oldest = runs.keys().next().value;
        if (oldest === undefined) break;
        runs.delete(oldest);
      }
    }
    if (trace.events.length >= MAX_EVENTS_PER_RUN) return; // bound a runaway loop
    // Drop the redundant `run` key from stored fields to keep events lean.
    const { run: _omit, ...rest } = fields;
    trace.events.push({ at: now - trace.startedAt, stage, level, fields: rest });
  } catch {
    /* observability must never break the agent */
  }
}

function summarize(trace: RunTrace): RunSummary {
  const s: RunSummary = {
    run: trace.run,
    startedAt: trace.startedAt,
    status: "running",
    events: trace.events.length,
  };
  let sawEnd = false;
  let sawFail = false;
  for (const e of trace.events) {
    const f = e.fields;
    switch (e.stage) {
      case "run_start":
        s.engine = str(f["engine"]) ?? s.engine;
        s.mode = str(f["mode"]) ?? s.mode;
        s.query = str(f["q"]) ?? s.query;
        break;
      case "research_loop":
        s.mode = str(f["mode"]) ?? s.mode;
        s.steps = num(f["steps"]) ?? s.steps;
        s.toolCalls = num(f["tool_calls"]) ?? s.toolCalls;
        s.sources = num(f["sources"]) ?? s.sources;
        s.answerChars = num(f["answer_chars"]) ?? s.answerChars;
        if (f["gate_requeried"] !== undefined) s.gateRequeried = f["gate_requeried"] === true;
        break;
      case "verification": {
        const fc = num(f["faith_checked"]);
        if (fc !== undefined) {
          s.faith = {
            checked: fc,
            supported: num(f["faith_supported"]) ?? 0,
            unsupported: num(f["faith_unsupported"]) ?? 0,
          };
        }
        const vc = num(f["facts_checked"]);
        if (vc !== undefined) s.verify = { checked: vc, verified: num(f["facts_verified"]) ?? 0 };
        break;
      }
      case "run_done":
        sawEnd = true;
        s.mode = str(f["mode"]) ?? s.mode;
        s.totalMs = num(f["total_ms"]) ?? s.totalMs;
        s.sources = num(f["sources"]) ?? s.sources;
        s.answerChars = num(f["answer_chars"]) ?? s.answerChars;
        s.status = str(f["status"]) === "complete" ? "complete" : "error";
        break;
      case "run_failed":
      case "no_answer":
      case "research_loop_failed":
        sawFail = true;
        s.error = str(f["error"]) ?? s.error;
        s.totalMs = num(f["total_ms"]) ?? s.totalMs;
        break;
    }
  }
  if (!sawEnd && sawFail) s.status = "error";
  return s;
}

/** Most-recent-first summaries of the runs still in the ring. */
export function getRunSummaries(): RunSummary[] {
  return [...runs.values()].map(summarize).reverse();
}

/** Full event timeline for one run, or null if it has aged out of the ring. */
export function getRunTrace(run: string): RunTrace | null {
  return runs.get(run) ?? null;
}

/** True when the collector is capturing (dev, or AGENT_TRACE=1). */
export function traceEnabled(): boolean {
  return enabled();
}
