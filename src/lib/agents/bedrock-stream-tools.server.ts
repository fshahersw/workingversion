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

const REGION = process.env["BEDROCK_REGION"] ?? "us-east-1";

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

/** Stream ONE ConverseStream turn: emit text deltas live, accumulate tool_use. */
async function streamOneTurn(
  req: {
    model: string;
    system: string;
    messages: BedrockMsg[];
    tools: BedrockToolDef[];
    maxTokens: number;
    cache?: boolean;
    temperature?: number;
    /** Adaptive-thinking effort (low|medium|high|xhigh|max). When set, sent via
     *  additionalModelRequestFields as output_config.effort with thinking.adaptive. */
    effort?: string;
    signal?: AbortSignal;
  },
  onText: (delta: string) => void,
): Promise<StreamTurn> {
  const body: Record<string, unknown> = {
    system: req.cache ? [{ text: req.system }, { cachePoint: { type: "default" } }] : [{ text: req.system }],
    messages: req.cache ? withMessageCache(req.messages) : req.messages,
    inferenceConfig: {
      maxTokens: req.maxTokens,
      ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
    },
    toolConfig: {
      tools: [
        ...req.tools.map((t) => ({
          toolSpec: { name: t.name, description: t.description, inputSchema: { json: t.input_schema } },
        })),
        ...(req.cache ? [{ cachePoint: { type: "default" } }] : []),
      ],
      toolChoice: { auto: {} },
    },
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
          if (typeof rc["text"] === "string") b.text += rc["text"];
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

export type StreamToolLoopResult = { narration: string; answer: string; steps: number };

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
  },
  handlers: {
    onText?: (delta: string) => void;
    onAnswer?: (delta: string) => void;
    onSynthesisStart?: () => void;
    onStep?: (s: { step: number; ms: number; stopReason: string; toolCalls: string[]; cacheReadTokens: number; cacheWriteTokens: number }) => void;
    onToolUse?: (call: BedrockToolCall) => void;
    execute: (call: BedrockToolCall) => Promise<string>;
  },
): Promise<StreamToolLoopResult> {
  const messages: BedrockMsg[] = [
    ...(opts.history ?? []).map(
      (h) => ({ role: h.role, content: [{ text: h.content }] }) as BedrockMsg,
    ),
    { role: "user", content: [{ text: opts.user }] },
  ];
  const perToolCap = opts.callBudget?.perTool ?? Number.POSITIVE_INFINITY;
  const totalCap = opts.callBudget?.total ?? Number.POSITIVE_INFINITY;
  const callCounts = new Map<string, number>();
  let totalCalls = 0;
  const deadline = opts.deadlineMs ? Date.now() + opts.deadlineMs : undefined;
  // Reserve time before the deadline for the synthesis turn — but ONLY once the
  // agent has researched enough (minCallsBeforeReserve tool calls). Applying it
  // unconditionally truncated slow-tool, under-researched cases to 1-2 sources
  // for no latency gain (synthesis thinking, not research time, dominates the
  // wall-clock). Below the threshold, research runs to the full deadline.
  const synthesisReserveMs = opts.synthesisReserveMs ?? 10_000;
  const minCallsBeforeReserve = opts.minCallsBeforeReserve ?? 6;
  const researchDeadline =
    deadline !== undefined ? deadline - synthesisReserveMs : undefined;
  let lastText = "";
  let steps = 0;

  for (; steps < opts.maxSteps; steps++) {
    // Below the research threshold, hold to the full deadline (don't starve
    // under-researched cases); past it, honor the synthesis reserve.
    const effectiveDeadline =
      researchDeadline !== undefined && totalCalls >= minCallsBeforeReserve
        ? researchDeadline
        : deadline;
    if (effectiveDeadline && Date.now() > effectiveDeadline) break;
    // Separate each step's narration onto its own line in the streamed thinking.
    if (steps > 0) handlers.onText?.("\n");
    const t0 = Date.now();
    const turn = await streamOneTurn(
      {
        model: opts.model,
        system: opts.system,
        messages,
        tools: opts.tools,
        maxTokens: opts.maxTokens,
        ...(opts.cache ? { cache: true } : {}),
        ...(opts.temperature !== undefined ? { temperature: opts.temperature } : {}),
        ...(opts.researchEffort ? { effort: opts.researchEffort } : {}),
        ...(opts.signal ? { signal: opts.signal } : {}),
      },
      handlers.onText ?? (() => {}),
    );
    handlers.onStep?.({ step: steps + 1, ms: Date.now() - t0, stopReason: turn.stopReason, toolCalls: turn.toolUses.map((t) => t.name), cacheReadTokens: turn.usage.cacheRead, cacheWriteTokens: turn.usage.cacheWrite });
    if (turn.text) lastText = turn.text;
    if (!turn.toolUses.length) break; // model stopped calling tools — done.

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
  handlers.onSynthesisStart?.();
  messages.push({ role: "user", content: [{ text: opts.synthesisUser }] } as BedrockMsg);
  const synthStart = Date.now();
  const synth = await streamOneTurn(
    {
      model: opts.model,
      system: opts.system,
      messages,
      tools: opts.tools, // kept on the wire (Bedrock requires it with toolUse history)
      // Floor the synthesis budget: Sonnet 5's always-on adaptive thinking shares
      // maxTokens with the answer, so too small a budget yields an EMPTY answer
      // (thinking hits the cap before any text). See research-agent's synthesisMaxTokens.
      maxTokens: Math.max(opts.synthesisMaxTokens ?? 12_000, 8_000),
      ...(opts.cache ? { cache: true } : {}),
      ...(opts.temperature !== undefined ? { temperature: opts.temperature } : {}),
      ...(opts.synthesisEffort ? { effort: opts.synthesisEffort } : {}),
      ...(opts.signal ? { signal: opts.signal } : {}),
    },
    handlers.onAnswer ?? (() => {}),
  );
  handlers.onStep?.({ step: steps + 1, ms: Date.now() - synthStart, stopReason: `synthesis:${synth.stopReason}`, toolCalls: [], cacheReadTokens: synth.usage.cacheRead, cacheWriteTokens: synth.usage.cacheWrite });

  return { narration: lastText, answer: synth.text, steps };
}
