// ============================================================================
// Streaming tool loop on Bedrock ConverseStream (server-only).
//
// Same shape as runBedrockToolLoop, but the model's narration STREAMS live
// (onText) as it works, and tool calls are parsed from the stream — so the UI
// can show "thinking in steps" in real time instead of bursts. Reuses the AWS
// event-stream frame decoder pattern from bedrock-claude.server; auth is SigV4
// (bedrock-sign). Prompt caching (cachePoint on tools+system) is supported.
// ============================================================================
import {
  signedBedrockFetch,
  isRetryableBedrockStatus,
  retryAfterMsFrom,
  bedrockRetryDelayMs,
  BEDROCK_MAX_RETRIES,
} from "./bedrock-sign.server";
import type { BedrockToolDef, BedrockToolCall, BedrockMsg } from "./bedrock.server";
import { isClaudeModel } from "./research-models";

const REGION = process.env["BEDROCK_REGION"] ?? "us-east-1";

/** Bounded one-time deadline extension granted when the comprehensiveness gate
 *  injects a targeted re-query round, so that round + the synthesis reserve have
 *  time even when the model stopped researching late. gateFired caps this to ONE
 *  use, so the added latency is bounded (a <=6s audit + one more tool round). */
const GATE_REQUERY_BUDGET_MS = 25_000;

function endpoint(model: string): string {
  return `https://bedrock-runtime.${REGION}.amazonaws.com/model/${encodeURIComponent(model)}/converse-stream`;
}

export class BedrockStreamError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
    this.name = "BedrockStreamError";
  }
}

// --- AWS event-stream frame decoder (payload JSON per frame) ----------------
type Bytes = Uint8Array<ArrayBufferLike>;

function concat(a: Bytes, b: Bytes): Bytes {
  const out = new Uint8Array(a.byteLength + b.byteLength);
  out.set(a, 0);
  out.set(b, a.byteLength);
  return out;
}

function decodeFrames(buf: Bytes): { events: string[]; rest: Bytes } {
  const events: string[] = [];
  let offset = 0;
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  while (buf.byteLength - offset >= 16) {
    const total = view.getUint32(offset);
    if (!Number.isFinite(total) || total <= 0 || total > 64 * 1024 * 1024) {
      return { events, rest: new Uint8Array(0) };
    }
    if (buf.byteLength - offset < total) break;
    const headersLen = view.getUint32(offset + 4);
    const payloadStart = offset + 12 + headersLen;
    const payloadEnd = offset + total - 4;
    if (payloadEnd > payloadStart) {
      events.push(new TextDecoder().decode(buf.subarray(payloadStart, payloadEnd)));
    }
    offset += total;
  }
  return { events, rest: buf.subarray(offset) };
}

type TurnUsage = { input: number; output: number; cacheRead: number; cacheWrite: number };
type StreamTurn = {
  text: string;
  toolUses: BedrockToolCall[];
  stopReason: string;
  usage: TurnUsage;
  /** Ordered assistant content blocks (text / toolUse / reasoningContent) to
   *  replay verbatim into history — thinking blocks carry a signature and must
   *  precede their toolUse blocks or Converse rejects the next turn. */
  assistantContent: unknown[];
};

function safeParse(s: string): Record<string, unknown> {
  const t = s.trim();
  if (!t) return {};
  try {
    return JSON.parse(t) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/** Put a moving cache breakpoint on the LAST message so the whole growing
 *  conversation (tool results across turns) is read from cache on every later
 *  turn — this, not just the tools+system prefix, is what keeps a long tool
 *  loop fast. Not persisted into the stored messages (so it doesn't stack). */
function withMessageCache(messages: BedrockMsg[]): unknown[] {
  if (!messages.length) return messages;
  const out: unknown[] = messages.slice(0, -1);
  const last = messages[messages.length - 1]!;
  const content = Array.isArray(last.content) ? (last.content as unknown[]) : [];
  out.push({ role: last.role, content: [...content, { cachePoint: { type: "default" } }] });
  return out;
}

/** Drop reasoningContent blocks from assistant turns. Used only when the writer
 *  (synthesis) model differs from the loop model: a reasoning block signed by the
 *  loop model is invalid for a different writer, so the writer sees just text,
 *  toolUse, and the toolResult turns. */
function stripReasoningBlocks(messages: BedrockMsg[]): BedrockMsg[] {
  return messages.map((m) => {
    if (m.role !== "assistant" || !Array.isArray(m.content)) return m;
    const content = (m.content as unknown[]).filter(
      (b) => !(b && typeof b === "object" && "reasoningContent" in (b as Record<string, unknown>)),
    );
    return { role: m.role, content } as BedrockMsg;
  });
}

/** Some loop models (Haiku 4.5, Nemotron) emit chain-of-thought as literal
 *  <think>...</think> in the TEXT channel instead of proper reasoningContent, so
 *  the tags leak into the narration/answer UI. Strip whole blocks AND any orphan
 *  open/close tag (streaming can split a block across turns, leaving a lone tag). */
function stripThinkTags(text: string): string {
  return text.replace(/<think>[\s\S]*?<\/think>/gi, "").replace(/<\/?think>/gi, "");
}

/** Stream ONE ConverseStream turn: emit text deltas live, accumulate tool_use.
 *  `tools` is optional — omit it for a tool-less turn (e.g. the frontier writer),
 *  in which case no toolConfig is sent. */
export async function streamOneTurn(
  req: {
    model: string;
    system: string;
    messages: BedrockMsg[];
    tools?: BedrockToolDef[];
    maxTokens: number;
    cache?: boolean;
    temperature?: number;
    /** Adaptive-thinking effort (low|medium|high|xhigh|max). When set, sent via
     *  additionalModelRequestFields as output_config.effort with thinking.adaptive. */
    effort?: string;
    signal?: AbortSignal;
  },
  onText: (delta: string) => void,
  onReasoning?: (delta: string) => void,
): Promise<StreamTurn> {
  const body: Record<string, unknown> = {
    system: req.cache ? [{ text: req.system }, { cachePoint: { type: "default" } }] : [{ text: req.system }],
    messages: req.cache ? withMessageCache(req.messages) : req.messages,
    inferenceConfig: {
      maxTokens: req.maxTokens,
      ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
    },
    // Tool-less turns (the frontier writer) send no toolConfig at all — Bedrock
    // rejects an empty tools array.
    ...(req.tools && req.tools.length
      ? {
          toolConfig: {
            tools: [
              ...req.tools.map((t) => ({
                toolSpec: { name: t.name, description: t.description, inputSchema: { json: t.input_schema } },
              })),
              ...(req.cache ? [{ cachePoint: { type: "default" } }] : []),
            ],
            toolChoice: { auto: {} },
          },
        }
      : {}),
    // Control Sonnet 5's always-on adaptive thinking. effort goes in output_config
    // (NOT inside thinking — Bedrock rejects thinking.adaptive.effort). Unset =
    // Bedrock default (~high). See scripts/probe-thinking.ts for the resolved shape.
    ...(req.effort
      ? {
          additionalModelRequestFields: {
            thinking: { type: "adaptive" },
            output_config: { effort: req.effort },
          },
        }
      : {}),
  };

  // Retry the initial request on throttling / transient 5xx with exponential
  // backoff (mirrors bedrockChat on the non-stream path). Once the stream has
  // started we cannot safely retry, so this guards the most common failure —
  // a ThrottlingException on the request itself — which previously abandoned
  // the whole loop and returned no answer.
  const bodyStr = JSON.stringify(body);
  let res: Response;
  for (let attempt = 0; ; attempt++) {
    res = await signedBedrockFetch(endpoint(req.model), {
      body: bodyStr,
      headers: { accept: "application/vnd.amazon.eventstream" },
      ...(req.signal ? { signal: req.signal } : {}),
    });
    if (res.ok && res.body) break;
    const retryAfterMs = retryAfterMsFrom(res);
    const detail = await res.text().catch(() => "");
    if (
      isRetryableBedrockStatus(res.status) &&
      attempt < BEDROCK_MAX_RETRIES &&
      !req.signal?.aborted
    ) {
      await new Promise((r) => setTimeout(r, bedrockRetryDelayMs(attempt, retryAfterMs)));
      continue;
    }
    throw new BedrockStreamError(
      res.status,
      `ConverseStream failed [${res.status}]: ${detail.slice(0, 300)}`,
    );
  }

  const reader = res.body.getReader();
  let pending: Bytes = new Uint8Array(0);
  let text = "";
  let stopReason = "end_turn";
  const usage: TurnUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  // Per contentBlockIndex accumulator. We rebuild the assistant turn's content
  // blocks IN ORDER (text / toolUse / reasoningContent) and replay them verbatim
  // into history: once adaptive thinking emits a signed reasoningContent block it
  // must precede its toolUse blocks or Converse rejects the next turn. `text` is
  // also concatenated for live streaming and the returned answer.
  type Acc =
    | { kind: "text"; text: string }
    | { kind: "tool"; id: string; name: string; input: string }
    | { kind: "reasoning"; text: string; signature: string };
  const blocks = new Map<number, Acc>();

  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    if (!value) continue;
    pending = concat(pending, value);
    const { events, rest } = decodeFrames(pending);
    pending = rest;
    for (const raw of events) {
      let evt: Record<string, unknown>;
      try {
        evt = JSON.parse(raw) as Record<string, unknown>;
      } catch {
        continue;
      }
      const idx = Number(evt["contentBlockIndex"] ?? -1);
      const start = evt["start"] as Record<string, unknown> | undefined;
      if (start?.["toolUse"]) {
        const tu = start["toolUse"] as { toolUseId?: string; name?: string };
        blocks.set(idx, { kind: "tool", id: String(tu.toolUseId ?? ""), name: String(tu.name ?? ""), input: "" });
        continue;
      }
      const delta = evt["delta"] as Record<string, unknown> | undefined;
      if (delta) {
        if (typeof delta["text"] === "string") {
          text += delta["text"];
          onText(delta["text"]);
          const b = blocks.get(idx);
          if (b && b.kind === "text") b.text += delta["text"];
          else blocks.set(idx, { kind: "text", text: String(delta["text"]) });
        } else if (delta["toolUse"] && typeof (delta["toolUse"] as Record<string, unknown>)["input"] === "string") {
          const b = blocks.get(idx);
          if (b && b.kind === "tool") b.input += String((delta["toolUse"] as Record<string, unknown>)["input"]);
        } else if (delta["reasoningContent"] && typeof delta["reasoningContent"] === "object") {
          const rc = delta["reasoningContent"] as Record<string, unknown>;
          let b = blocks.get(idx);
          if (!b || b.kind !== "reasoning") {
            b = { kind: "reasoning", text: "", signature: "" };
            blocks.set(idx, b);
          }
          if (typeof rc["text"] === "string") {
            b.text += rc["text"];
            onReasoning?.(String(rc["text"]));
          }
          if (typeof rc["signature"] === "string") b.signature = String(rc["signature"]);
        }
        continue;
      }
      if (typeof evt["stopReason"] === "string") {
        stopReason = String(evt["stopReason"]);
        continue;
      }
      if (evt["usage"] && typeof evt["usage"] === "object") {
        const u = evt["usage"] as Record<string, unknown>;
        usage.input = Number(u["inputTokens"] ?? usage.input);
        usage.output = Number(u["outputTokens"] ?? usage.output);
        usage.cacheRead = Number(u["cacheReadInputTokens"] ?? usage.cacheRead);
        usage.cacheWrite = Number(u["cacheWriteInputTokens"] ?? usage.cacheWrite);
        continue;
      }
      // Exception frames (throttling / validation) arrive as a bare { message }.
      if (evt["role"] === undefined && evt["usage"] === undefined && evt["metrics"] === undefined) {
        const errMsg = evt["message"] ?? evt["Message"];
        if (typeof errMsg === "string" && errMsg) {
          throw new BedrockStreamError(500, `ConverseStream error: ${errMsg}`);
        }
      }
    }
  }

  // Walk the blocks in content-index order, building the tool-call list AND the
  // verbatim assistant content in one pass. Drop empty text blocks; replay a
  // reasoning block only when it is SIGNED (an unsigned/empty one is invalid).
  const ordered = [...blocks.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, b]) => b);
  const toolUses: BedrockToolCall[] = [];
  const assistantContent: unknown[] = [];
  for (const b of ordered) {
    if (b.kind === "text") {
      if (b.text) assistantContent.push({ text: b.text });
    } else if (b.kind === "tool") {
      if (!b.id || !b.name) continue;
      const input = safeParse(b.input);
      toolUses.push({ id: b.id, name: b.name, input });
      assistantContent.push({ toolUse: { toolUseId: b.id, name: b.name, input } });
    } else if (b.signature) {
      assistantContent.push({
        reasoningContent: { reasoningText: { text: b.text, signature: b.signature } },
      });
    }
  }
  return { text, toolUses, stopReason, usage, assistantContent };
}

export type StreamToolLoopResult = {
  narration: string;
  answer: string;
  steps: number;
  /** True when the comprehensiveness gate injected a targeted re-query round
   *  before synthesis (quality plan A) — for eval attribution. */
  gateRequeried: boolean;
  /** True when the first turn's tool-less reply was streamed as the answer
   *  (no separate synthesis turn). */
  direct?: boolean;
};

/** Streaming research loop + merged synthesis. During research the model's
 *  narration streams via onText and tool_use blocks execute in parallel; when
 *  it stops (or the budget is hit) a FINAL no-new-tools turn streams the answer
 *  via onAnswer, synthesizing from the in-context tool results — one continuous
 *  stream, no separate writer pass. The final turn keeps toolConfig on the wire
 *  (Bedrock requires it once the history holds toolUse/toolResult blocks) but is
 *  instructed not to call tools. */
export async function streamConverseToolLoop(
  opts: {
    model: string;
    system: string;
    user: string;
    /** Prior conversation turns (verbatim), prepended before the current user
     *  turn so the model has REAL multi-turn context — not only the rolling
     *  summary. Empty on a first turn. */
    history?: { role: "user" | "assistant"; content: string }[];
    tools: BedrockToolDef[];
    maxTokens: number;
    maxSteps: number;
    /** Instruction appended as the final user turn to trigger the written answer. */
    synthesisUser: string;
    synthesisMaxTokens?: number;
    /** Optional writer model for the final synthesis turn (defaults to `model`).
     *  Lets a fast tool-caller loop hand the final prose to a stronger writer. */
    synthesisModel?: string;
    /** Optional system prompt for the final synthesis turn (defaults to `system`).
     *  Lets the tool-driver loop and the writer run on SEPARATE prompts: a lean
     *  gather-only prompt drives the loop, a writer prompt composes the answer. */
    synthesisSystem?: string;
    cache?: boolean;
    temperature?: number;
    signal?: AbortSignal;
    callBudget?: { perTool?: number; total?: number };
    deadlineMs?: number;
    /** Hard per-tool wall-clock cap (ms). Default 20s. */
    perToolTimeoutMs?: number;
    /** Time reserved before the deadline for the synthesis turn (ms). Default 10s. */
    synthesisReserveMs?: number;
    /** Only apply synthesisReserveMs once this many tool calls have run, so
     *  under-researched cases keep researching to the full deadline. Default 6. */
    minCallsBeforeReserve?: number;
    /** Adaptive-thinking effort for research turns (low..max). Unset = Bedrock
     *  default. Lower = faster/cheaper, less deliberation before tool choices. */
    researchEffort?: string;
    /** Adaptive-thinking effort for the final synthesis turn. Unset = default. */
    synthesisEffort?: string;
    /** Comprehensiveness gate (quality plan A). Consulted ONCE, when the model
     *  first stops calling tools with a spare step and time before the synthesis
     *  reserve: if the gathered sources leave a genuine coverage gap, return a
     *  bounded re-query instruction (injected as a user turn) to run one more
     *  targeted research round before synthesis; return null to synthesize now. */
    gate?: {
      check: (ctx: {
        steps: number;
        totalCalls: number;
        researchMsLeft: number;
      }) => Promise<string | null>;
    };
    /** Direct answer: when the model's FIRST turn calls no tools and writes a
     *  complete reply (a follow-up it can answer from the conversation and the
     *  carried sources), stream that reply as the answer instead of dropping it
     *  and paying for a second synthesis turn. Only after the gate (if any) has
     *  passed, only on a clean end_turn stop, and only above minChars so a bare
     *  status line never becomes the answer. */
    directAnswer?: { minChars?: number };
    /** No-tool nudge: when the FIRST turn calls no tools and there is no
     *  conversation context to answer from, push this instruction once and give
     *  the model one more turn to research before it answers from memory. */
    noToolNudge?: string;
  },
  handlers: {
    onText?: (delta: string) => void;
    onReasoning?: (delta: string) => void;
    onAnswer?: (delta: string) => void;
    onSynthesisStart?: () => void;
    onStep?: (s: { step: number; ms: number; stopReason: string; toolCalls: string[]; inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number }) => void;
    onToolUse?: (call: BedrockToolCall) => void;
    execute: (call: BedrockToolCall) => Promise<string>;
  },
): Promise<StreamToolLoopResult> {
  // Normalize prior turns: Converse requires strictly alternating roles starting
  // with user. Drop a leading assistant, collapse same-role repeats, and — since
  // the current turn we append is a user message — ensure the prior block ends on
  // an assistant turn. A malformed tail would otherwise make Converse reject the
  // whole request with a ValidationException.
  const prior: { role: "user" | "assistant"; content: string }[] = [];
  for (const h of opts.history ?? []) {
    if (!h.content?.trim()) continue;
    if (prior.length === 0 && h.role !== "user") continue;
    if (prior.length && prior[prior.length - 1]!.role === h.role) continue;
    prior.push({ role: h.role, content: h.content });
  }
  if (prior.length && prior[prior.length - 1]!.role === "user") prior.pop();
  const messages: BedrockMsg[] = [
    ...prior.map(
      (h) => ({ role: h.role, content: [{ text: h.content }] }) as BedrockMsg,
    ),
    { role: "user", content: [{ text: opts.user }] },
  ];
  const perToolCap = opts.callBudget?.perTool ?? Number.POSITIVE_INFINITY;
  const totalCap = opts.callBudget?.total ?? Number.POSITIVE_INFINITY;
  const callCounts = new Map<string, number>();
  let totalCalls = 0;
  let deadline = opts.deadlineMs ? Date.now() + opts.deadlineMs : undefined;
  // Reserve time before the deadline for the synthesis turn — but ONLY once the
  // agent has researched enough (minCallsBeforeReserve tool calls). Applying it
  // unconditionally truncated slow-tool, under-researched cases to 1-2 sources
  // for no latency gain (synthesis thinking, not research time, dominates the
  // wall-clock). Below the threshold, research runs to the full deadline.
  const synthesisReserveMs = opts.synthesisReserveMs ?? 10_000;
  const minCallsBeforeReserve = opts.minCallsBeforeReserve ?? 6;
  let researchDeadline =
    deadline !== undefined ? deadline - synthesisReserveMs : undefined;
  let lastText = "";
  let steps = 0;
  // Comprehensiveness gate (quality plan A) fires at most once: gateFired guards
  // the single consult; gateRequeried records whether it actually injected a
  // targeted re-query round (returned to the caller for eval attribution).
  let gateFired = false;
  let gateRequeried = false;
  let nudged = false;

  for (; steps < opts.maxSteps; steps++) {
    // Below the research threshold, hold to the full deadline (don't starve
    // under-researched cases); past it, honor the synthesis reserve.
    const effectiveDeadline =
      researchDeadline !== undefined && totalCalls >= minCallsBeforeReserve
        ? researchDeadline
        : deadline;
    if (effectiveDeadline && Date.now() > effectiveDeadline) break;
    const t0 = Date.now();
    // Buffer this turn's text instead of streaming it straight to the reasoning
    // channel. A research turn narrates a short status line and then calls tools;
    // when the model decides it is done it instead writes the ANSWER as text with
    // no tool calls. That answer must NOT leak into the reasoning stream, so we
    // hold the text and surface it as narration only once the turn is confirmed to
    // have called tools. A no-tool turn's draft is dropped — the clean answer comes
    // from the synthesis turn below (streamed to the answer channel, not here).
    let turnText = "";
    const turn = await streamOneTurn(
      {
        model: opts.model,
        system: opts.system,
        messages,
        tools: opts.tools,
        maxTokens: opts.maxTokens,
        // cache + adaptive-thinking effort are Claude-only; a non-Claude loop
        // model (e.g. Nemotron) 400s on cachePoint / thinking.adaptive.
        ...(opts.cache && isClaudeModel(opts.model) ? { cache: true } : {}),
        ...(opts.temperature !== undefined ? { temperature: opts.temperature } : {}),
        ...(opts.researchEffort && isClaudeModel(opts.model) ? { effort: opts.researchEffort } : {}),
        ...(opts.signal ? { signal: opts.signal } : {}),
      },
      (delta) => {
        turnText += delta;
      },
      handlers.onReasoning,
    );
    handlers.onStep?.({ step: steps + 1, ms: Date.now() - t0, stopReason: turn.stopReason, toolCalls: turn.toolUses.map((t) => t.name), inputTokens: turn.usage.input, outputTokens: turn.usage.output, cacheReadTokens: turn.usage.cacheRead, cacheWriteTokens: turn.usage.cacheWrite });
    if (turn.text) lastText = turn.text;
    if (!turn.toolUses.length) {
      // The model wants to stop researching. If a comprehensiveness gate is
      // configured and there is budget + time for one more targeted round,
      // consult it ONCE: a genuine coverage gap triggers a bounded re-query
      // rather than synthesizing over a hole. Guarded so the injected re-query
      // is actually consumed by a model turn (needs a spare step) and so the
      // gate never runs once time/budget is already spent.
      if (
        opts.gate &&
        !gateFired &&
        steps < opts.maxSteps - 1 &&
        totalCalls < totalCap &&
        turn.assistantContent.length > 0
      ) {
        gateFired = true;
        // Consult unconditionally on a voluntary stop — the audit is itself hard-
        // capped (~6s) and fail-safe, so we no longer gate the CONSULT on remaining
        // time (that guard closed the window before Think research ever finished).
        const researchMsLeft =
          (researchDeadline ?? Number.POSITIVE_INFINITY) - Date.now();
        let instruction: string | null = null;
        try {
          instruction = await opts.gate.check({ steps, totalCalls, researchMsLeft });
        } catch {
          instruction = null;
        }
        if (instruction) {
          // A gap remains though the model stopped. Grant a bounded, ONE-TIME
          // deadline extension so the targeted re-query round + synthesis reserve
          // have time even if research already ran long — gateFired caps it to
          // one, so latency stays bounded.
          if (deadline !== undefined) {
            deadline += GATE_REQUERY_BUDGET_MS;
            researchDeadline = deadline - synthesisReserveMs;
          }
          // Replay the model's (dropped) draft turn so roles stay alternating,
          // then steer it back to targeted research. The next iteration runs the
          // bounded re-query round; when the model stops again the gate is spent
          // (gateFired) and the loop proceeds to synthesis.
          messages.push({
            role: "assistant",
            content: turn.assistantContent,
          } as unknown as BedrockMsg);
          messages.push({ role: "user", content: [{ text: instruction }] } as BedrockMsg);
          gateRequeried = true;
          continue;
        }
      }
      const draft = stripThinkTags(turnText).trim();
      // First turn, no tools, complete reply, gate satisfied: this IS the answer.
      if (
        opts.directAnswer &&
        steps === 0 &&
        totalCalls === 0 &&
        turn.stopReason === "end_turn" &&
        draft.length >= (opts.directAnswer.minChars ?? 160)
      ) {
        handlers.onSynthesisStart?.();
        handlers.onAnswer?.(draft);
        return { narration: "", answer: draft, steps: steps + 1, gateRequeried, direct: true };
      }
      // First turn, no tools, nothing to answer from: one chance to research.
      if (
        opts.noToolNudge &&
        !nudged &&
        steps === 0 &&
        totalCalls === 0 &&
        steps < opts.maxSteps - 1 &&
        turn.assistantContent.length > 0
      ) {
        nudged = true;
        messages.push({ role: "assistant", content: turn.assistantContent } as unknown as BedrockMsg);
        messages.push({ role: "user", content: [{ text: opts.noToolNudge }] } as BedrockMsg);
        continue;
      }
      break; // model is answering — drop the draft; synthesis writes the answer.
    }

    // Confirmed research turn: surface its short narration as one reasoning line.
    const narration = stripThinkTags(turnText).trim();
    if (narration) handlers.onText?.((steps > 0 ? "\n" : "") + narration);

    // Replay the assistant turn's content blocks VERBATIM (text, toolUse, and any
    // signed reasoningContent, in order) so a thinking block correctly precedes
    // its toolUse blocks — Converse rejects the next turn otherwise once adaptive
    // thinking is emitting reasoning.
    messages.push({ role: "assistant", content: turn.assistantContent } as unknown as BedrockMsg);

    // Execute in parallel; budget accounting is synchronous (before any await).
    const outputs = await Promise.all(
      turn.toolUses.map((call) => {
        const used = callCounts.get(call.name) ?? 0;
        if (totalCalls >= totalCap) {
          return Promise.resolve({ id: call.id, content: `TOOL BUDGET EXHAUSTED (${totalCap} total). Stop calling tools and write your answer from what you have.`, ok: true });
        }
        if (used >= perToolCap) {
          return Promise.resolve({ id: call.id, content: `TOOL BUDGET EXHAUSTED for ${call.name} (cap ${perToolCap}). Use a different tool or write from what you have.`, ok: true });
        }
        callCounts.set(call.name, used + 1);
        totalCalls++;
        handlers.onToolUse?.(call);
        return (async () => {
          // Hard per-tool cap so one slow/hung tool cannot consume the whole
          // wall-clock budget. The underlying call is not cancelled (tools carry
          // their own internal AbortSignal timeouts); this stops the loop from
          // blocking on it and feeds the model a timeout notice instead.
          const timeoutMs = opts.perToolTimeoutMs ?? 20_000;
          try {
            const content = await Promise.race([
              handlers.execute(call),
              new Promise<string>((_, reject) =>
                setTimeout(
                  () => reject(new Error(`tool timed out after ${timeoutMs}ms`)),
                  timeoutMs,
                ),
              ),
            ]);
            return { id: call.id, content, ok: true };
          } catch (err) {
            return { id: call.id, content: `Tool error: ${err instanceof Error ? err.message : "failed"}`, ok: false };
          }
        })();
      }),
    );
    messages.push({
      role: "user",
      content: outputs.map((o) => ({
        toolResult: { toolUseId: o.id, content: [{ text: o.content }], status: o.ok ? ("success" as const) : ("error" as const) },
      })),
    } as BedrockMsg);
  }

  // --- Final synthesis turn: no new tools, stream the answer -----------------
  // FAST hands the write to a stronger writer model (Sonnet) while the loop ran
  // on a quick caller (Nemotron), and gives that writer its OWN system prompt
  // (synthesisSystem) so the loop prompt can stay gather-only. When the writer
  // differs from the loop model, strip loop-model-signed reasoning blocks so the
  // writer accepts the history.
  handlers.onSynthesisStart?.();
  messages.push({ role: "user", content: [{ text: opts.synthesisUser }] } as BedrockMsg);
  const writer = opts.synthesisModel ?? opts.model;
  const synthMessages = writer === opts.model ? messages : stripReasoningBlocks(messages);
  const synthStart = Date.now();
  const synth = await streamOneTurn(
    {
      model: writer,
      system: opts.synthesisSystem ?? opts.system,
      messages: synthMessages,
      tools: opts.tools, // kept on the wire (Bedrock requires it with toolUse history)
      // Floor the synthesis budget: Sonnet 5's always-on adaptive thinking shares
      // maxTokens with the answer, so too small a budget yields an EMPTY answer
      // (thinking hits the cap before any text). See research-agent's synthesisMaxTokens.
      maxTokens: Math.max(opts.synthesisMaxTokens ?? 12_000, 8_000),
      ...(opts.cache && isClaudeModel(writer) ? { cache: true } : {}),
      ...(opts.temperature !== undefined ? { temperature: opts.temperature } : {}),
      ...(opts.synthesisEffort && isClaudeModel(writer) ? { effort: opts.synthesisEffort } : {}),
      ...(opts.signal ? { signal: opts.signal } : {}),
    },
    handlers.onAnswer ?? (() => {}),
    handlers.onReasoning,
  );
  handlers.onStep?.({ step: steps + 1, ms: Date.now() - synthStart, stopReason: `synthesis:${synth.stopReason}`, toolCalls: [], inputTokens: synth.usage.input, outputTokens: synth.usage.output, cacheReadTokens: synth.usage.cacheRead, cacheWriteTokens: synth.usage.cacheWrite });

  return { narration: lastText, answer: synth.text, steps, gateRequeried, direct: false };
}
