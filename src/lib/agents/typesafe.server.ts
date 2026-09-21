// ============================================================================
// TypeSafe System One client (server-only) — the router model.
//
// Jev answers TYPED questions (choice / score / noul) about a `state` and
// returns probabilities plus a confidence statistic (not a correctness guarantee), for
// $0.042 per million input tokens (output is free). That is the shape of every
// routing decision this app makes today with a generative model round trip
// (Office task class on Haiku, frontier RoutePlan on Nemotron, topic-shift on
// Haiku) or with regexes (research fast/think). Docs: https://docs.typesafe.ai
//
// Built for the critical path, so it deliberately differs from the vendor SDK:
//   - HARD wall-clock cap per call (TYPESAFE_TIMEOUT_MS, default 800 ms) and NO
//     retries by default. A router that is late is a router that lost; every
//     caller treats `null` as "no opinion" and falls back to its current path.
//   - No opinion on failure: network/HTTP/parse failures return null and log a
//     stage line with counts and latency only. Question text and state are
//     never logged.
//   - Pinned model by default (jev-1.13.0). `jev-latest` moves on release and
//     would silently shift every threshold tuned in typesafe-questions.ts.
//   - The key comes from TYPESAFE_API_KEY (Secrets Manager at deploy). Absent
//     key => typesafeConfigured() is false and no request is ever made.
//
// One request carries MANY questions (speculative fan-out): they are evaluated
// in parallel against the same state, so ask everything the decision might
// need and let code pick. Budget: 64k tokens per request, 32k for state plus
// the longest question; Choice accepts up to 255 options.
// ============================================================================
import { agentError, agentLog } from "./log.server";

export const TYPESAFE_DEFAULT_MODEL = "jev-1.13.0";
const ENDPOINT_PATH = "/v1/systemone";

const env = (name: string): string => (process.env[name] ?? "").trim();

export function typesafeConfigured(): boolean {
  return !!env("TYPESAFE_API_KEY");
}

export function typesafeModel(): string {
  return env("TYPESAFE_MODEL") || TYPESAFE_DEFAULT_MODEL;
}

/** Router budget: the whole call, including connect and body, must finish inside this. */
export function typesafeTimeoutMs(): number {
  const n = Number(env("TYPESAFE_TIMEOUT_MS"));
  return Number.isFinite(n) && n > 0 ? n : 800;
}

// --- Question types (mirror the HTTP API) -------------------------------------

/** Instructions and criteria accept a string or JSON structure (objects/arrays). */
export type Description = string | Record<string, unknown> | unknown[];

export type ChoiceQuestion = {
  type: "choice";
  instructions: Description;
  /** option -> description (null when the name is self-explanatory) */
  criteria: Record<string, Description | null>;
};
export type ScoreQuestion = { type: "score"; instructions: Description; criteria: Description[] };
export type NoulQuestion = {
  type: "noul";
  instructions: Description;
  criteria?: { true?: Description; false?: Description };
};
export type Question = ChoiceQuestion | ScoreQuestion | NoulQuestion;

export const choice = (
  instructions: Description,
  criteria: Record<string, Description | null>,
): ChoiceQuestion => ({ type: "choice", instructions, criteria });
export const score = (instructions: Description, criteria: Description[]): ScoreQuestion => ({
  type: "score",
  instructions,
  criteria,
});
export const noul = (instructions: Description, criteria?: NoulQuestion["criteria"]): NoulQuestion => ({
  type: "noul",
  instructions,
  ...(criteria ? { criteria } : {}),
});

// --- Answer types -----------------------------------------------------------

export type ChoiceAnswer = {
  type: "choice";
  choice: string;
  probabilities: Record<string, number>;
  confidence: number;
};
export type ScoreAnswer = {
  type: "score";
  score: number;
  legend: Record<string, string>;
  probabilities: Record<string, number>;
  confidence: number;
};
export type NoulAnswer = { type: "noul"; noul: number };
export type Answer = ChoiceAnswer | ScoreAnswer | NoulAnswer;

export type SystemOneResult = {
  model: string;
  answers: Record<string, Answer>;
  usage: { inputTokens: number; outputTokens: number };
  ms: number;
};

export type SystemOneRequest = {
  /** short machine label for logs ("office_route", "research_effort") */
  purpose: string;
  state: string | Record<string, unknown> | unknown[];
  questions: Record<string, Question>;
  signal?: AbortSignal;
  /** override the router budget for non-critical-path uses */
  timeoutMs?: number;
  /** retries on 408/429/5xx/network (default 0: routers fail open instead) */
  retries?: number;
  model?: string;
  /** test seam */
  fetchImpl?: typeof fetch;
};

export class TypeSafeError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "TypeSafeError";
    this.status = status;
  }
}

function baseUrl(): string {
  return (env("TYPESAFE_BASE_URL") || "https://api.typesafe.ai").replace(/\/+$/, "");
}

const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const probability = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1;
const tokenCount = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;

/** Validate against the question, not just an untrusted response's type tag. */
export function validAnswer(v: unknown, q: Question): v is Answer {
  if (!record(v) || v.type !== q.type) return false;
  if (q.type === "noul") return probability(v.noul);
  if (!probability(v.confidence) || !record(v.probabilities)) return false;
  const keys = q.type === "choice" ? Object.keys(q.criteria) : q.criteria.map((_, i) => String(i));
  const p = v.probabilities;
  if (!keys.length || Object.keys(p).length !== keys.length || !keys.every(k => Object.hasOwn(p, k) && probability(p[k]))) return false;
  // The service rounds probabilities to two decimals. Accommodate only that
  // rounding error; malformed distributions must never justify a down-route.
  const sum = keys.reduce((s, k) => s + (p[k] as number), 0);
  if (Math.abs(sum - 1) > Math.max(0.015, Math.min(0.05, keys.length * 0.005 + 1e-8))) return false;
  if (q.type === "choice") return typeof v.choice === "string" && keys.includes(v.choice)
    && (p[v.choice] as number) + 0.011 >= Math.max(...keys.map(k => p[k] as number));
  return typeof v.score === "number" && Number.isFinite(v.score) && v.score >= 0 && v.score <= keys.length - 1
    && record(v.legend) && Object.keys(v.legend).length === keys.length
    && keys.every(k => Object.hasOwn(v.legend as object, k) && typeof (v.legend as Record<string, unknown>)[k] === "string");
}

/** Race even an uncooperative transport/body reader against cancellation. */
async function withinSignal<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw signal.reason;
  let stop!: () => void;
  const aborted = new Promise<never>((_, reject) => {
    stop = () => reject(signal.reason ?? new Error("Aborted"));
    signal.addEventListener("abort", stop, { once: true });
  });
  try { return await Promise.race([work, aborted]); }
  finally { signal.removeEventListener("abort", stop); }
}

async function retryPause(ms: number, signal: AbortSignal): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { await withinSignal(new Promise<void>(resolve => { timer = setTimeout(resolve, ms); }), signal); }
  finally { clearTimeout(timer); }
}

/**
 * One System One request. Resolves to null (never throws) when the key is
 * missing, the call exceeds its budget, the API errors, or the body is not the
 * documented shape. Callers must treat null as "no opinion".
 */
export async function systemOne(req: SystemOneRequest): Promise<SystemOneResult | null> {
  const apiKey = env("TYPESAFE_API_KEY");
  if (!apiKey || req.signal?.aborted) return null;
  const questionIds = Object.keys(req.questions);
  if (!questionIds.length) return null;
  const budget = req.timeoutMs ?? typesafeTimeoutMs();
  if (!Number.isFinite(budget) || budget <= 0) return null;
  const retries = Number.isFinite(req.retries) ? Math.min(3, Math.max(0, Math.floor(req.retries!))) : 0;
  const model = req.model ?? typesafeModel();
  const doFetch = req.fetchImpl ?? fetch;
  const started = Date.now();
  let body: string;
  try { body = JSON.stringify({ state: req.state, model, questions: req.questions }); }
  catch { return null; }

  let attempt = 0;
  for (;;) {
    const remaining = budget - (Date.now() - started);
    if (req.signal?.aborted) return null;
    if (remaining <= 0) {
      agentError("typesafe_failed", { purpose: req.purpose, kind: "budget", ms: Date.now() - started });
      return null;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error(`typesafe timed out after ${budget}ms`)), remaining);
    const onParent = () => controller.abort(req.signal?.reason);
    req.signal?.addEventListener("abort", onParent, { once: true });
    try {
      const res = await withinSignal(doFetch(`${baseUrl()}${ENDPOINT_PATH}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json", Accept: "application/json" },
        body,
        signal: controller.signal,
        redirect: "error",
      }), controller.signal);
      if (!res.ok) {
        const retryable = res.status === 408 || res.status === 429 || res.status === 529 || res.status >= 500;
        if (retryable && attempt < retries) {
          attempt++;
          await retryPause(Math.min(250 * 2 ** (attempt - 1), Math.max(0, budget - (Date.now() - started)) / 2), controller.signal);
          continue;
        }
        agentError("typesafe_failed", { purpose: req.purpose, kind: "http", status: res.status, ms: Date.now() - started });
        return null;
      }
      const json = (await withinSignal(res.json(), controller.signal)) as {
        model?: string;
        answers?: Record<string, unknown>;
        usage?: { input_tokens?: number; output_tokens?: number };
      };
      if (!record(json) || typeof json.model !== "string" || !json.model
        || (!/^(jev-latest|jev-preview)$/.test(model) && json.model !== model)
        || !record(json.answers) || !record(json.usage)
        || !tokenCount(json.usage.input_tokens) || !tokenCount(json.usage.output_tokens)) return null;
      const answers: Record<string, Answer> = {};
      for (const id of questionIds) {
        const a = json.answers?.[id];
        if (!validAnswer(a, req.questions[id]!)) {
          agentError("typesafe_failed", { purpose: req.purpose, kind: "shape", missing: id, ms: Date.now() - started });
          return null;
        }
        answers[id] = a;
      }
      const ms = Date.now() - started;
      agentLog("typesafe_call", {
        purpose: req.purpose,
        model: json.model ?? model,
        questions: questionIds.length,
        input_tokens: json.usage?.input_tokens ?? 0,
        ms,
      });
      return {
        model: json.model ?? model,
        answers,
        usage: { inputTokens: json.usage?.input_tokens ?? 0, outputTokens: json.usage?.output_tokens ?? 0 },
        ms,
      };
    } catch (err) {
      if (req.signal?.aborted) return null; // the caller gave up; nothing to log
      const network = !controller.signal.aborted;
      if (network && attempt < retries) {
        attempt++;
        continue;
      }
      agentError("typesafe_failed", {
        purpose: req.purpose,
        kind: network ? "network" : "timeout",
        ms: Date.now() - started,
      });
      return null;
    } finally {
      clearTimeout(timer);
      req.signal?.removeEventListener("abort", onParent);
    }
  }
}

// --- Typed accessors (narrow without throwing) ------------------------------------

export function choiceAnswer(res: SystemOneResult | null, id: string): ChoiceAnswer | null {
  const a = res?.answers[id];
  return a && a.type === "choice" ? a : null;
}
export function noulAnswer(res: SystemOneResult | null, id: string): number | null {
  const a = res?.answers[id];
  return a && a.type === "noul" ? a.noul : null;
}
export function scoreAnswer(res: SystemOneResult | null, id: string): ScoreAnswer | null {
  const a = res?.answers[id];
  return a && a.type === "score" ? a : null;
}
