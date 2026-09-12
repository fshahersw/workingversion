// ============================================================================
// AWS Bedrock client (server-only) — NVIDIA Nemotron for the research loop.
//
// Uses Bedrock's provider-agnostic `converse` API over raw HTTPS with SigV4
// signing and the default AWS credential chain. The runtime role therefore
// needs scoped Bedrock model-invocation permissions.
//
// Exposes the same shapes as fireworks.server.ts so the orchestrator can swap
// providers without touching tools.server.ts or the SSE emitter.
//
// Auth: SigV4 via the default credential chain (see bedrock-sign.server.ts) —
// no static bearer token.
// ============================================================================
import {
  signedBedrockFetch,
  bedrockCredsReady,
  isRetryableBedrockStatus,
  retryAfterMsFrom,
  bedrockRetryDelayMs,
  BEDROCK_MAX_RETRIES,
} from "@/lib/agents/bedrock-sign.server";

const REGION = process.env["BEDROCK_REGION"] ?? "us-east-1";

/** Router + sub-agent model. Text-in / text-out, on-demand, us-east-1. */
export const BEDROCK_AGENT_MODEL =
  process.env["BEDROCK_AGENT_MODEL"] || "us.anthropic.claude-haiku-4-5-20251001-v1:0";

/** Bedrock per-request processing tier (Converse `serviceTier.type`). */
export type ServiceTier = "priority" | "default" | "flex" | "reserved";

function parseTier(raw: string | undefined): ServiceTier | undefined {
  const t = (raw ?? "").trim().toLowerCase();
  return t === "priority" || t === "default" || t === "flex" || t === "reserved" ? t : undefined;
}

/** Tier applied to every call on BEDROCK_AGENT_MODEL (the side calls: coverage
 *  gate, memory refresh, follow-ups, conversational replies). Set it only for a
 *  model that supports the tier (Nova / Qwen / DeepSeek / MiniMax accept
 *  `priority` and `flex`; Claude accepts only `default` / `reserved` and 400s
 *  on the others), e.g. BEDROCK_AGENT_MODEL=<nova-2-lite id> BEDROCK_AGENT_TIER=priority. */
export const BEDROCK_AGENT_TIER: ServiceTier | undefined = parseTier(process.env["BEDROCK_AGENT_TIER"]);

/** Claude accepts only the default/reserved tiers; sending priority/flex to a
 *  Claude id is a 400. A misconfigured BEDROCK_AGENT_TIER must degrade to the
 *  Bedrock default instead of failing every side call. */
export function tierAllowedFor(model: string, tier: ServiceTier): boolean {
  if (tier === "default" || tier === "reserved") return true;
  return !/anthropic\.claude/.test(model);
}

export class BedrockError extends Error {
  status: number;
  /** Server-sent Retry-After (ms), when present, so bedrockChat can honor it. */
  retryAfterMs?: number;
  constructor(status: number, message: string, retryAfterMs?: number) {
    super(message);
    this.status = status;
    this.retryAfterMs = retryAfterMs;
    this.name = "BedrockError";
  }
}

export function bedrockEnabled(): boolean {
  return bedrockCredsReady();
}

// ---------------------------------------------------------------------------
// converse wire types (only the parts we use)
// ---------------------------------------------------------------------------

type ContentBlock =
  | { text: string }
  | { toolUse: { toolUseId: string; name: string; input: Record<string, unknown> } }
  | {
      toolResult: {
        toolUseId: string;
        content: { text: string }[];
        status?: "success" | "error";
      };
    };

export type BedrockMsg = { role: "user" | "assistant"; content: ContentBlock[] };

export type BedrockToolDef = {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
};

export type BedrockToolCall = {
  id: string;
  name: string;
  input: Record<string, unknown>;
};

export type BedrockChatRequest = {
  model: string;
  system: string;
  messages: BedrockMsg[];
  tools?: BedrockToolDef[];
  /** Force a specific tool, or require any tool. */
  toolChoice?: "auto" | "any" | { name: string };
  maxTokens: number;
  temperature?: number;
  /** Cache the tools + system prefix across turns (Claude models only). Cuts
   *  per-turn input ~90% and does not count against rate limits. */
  cache?: boolean;
  /** Processing tier for this request. Defaults to BEDROCK_AGENT_TIER when the
   *  request runs on BEDROCK_AGENT_MODEL, else unset (Bedrock default). */
  serviceTier?: ServiceTier;
  signal?: AbortSignal;
};

export type BedrockChatResult = {
  text: string;
  toolCalls: BedrockToolCall[];
  /** The assistant turn, ready to append to the next request's messages. */
  raw: BedrockMsg;
  stopReason: string;
  /** Token usage reported by converse (0s when the provider omits it). */
  usage: { input: number; output: number; cacheRead: number; cacheWrite: number };
};

function endpoint(model: string): string {
  return `https://bedrock-runtime.${REGION}.amazonaws.com/model/${encodeURIComponent(model)}/converse`;
}

/** Plain text helper — a user message with no tools. */
export function userText(text: string): BedrockMsg {
  return { role: "user", content: [{ text }] };
}

async function converseOnce(req: BedrockChatRequest): Promise<BedrockChatResult> {
  const body: Record<string, unknown> = {
    messages: req.messages,
    // A cachePoint after the system text caches the tools+system prefix so every
    // later turn in the loop reads it cheaply (Bedrock Converse, Claude only).
    system: req.cache
      ? [{ text: req.system }, { cachePoint: { type: "default" } }]
      : [{ text: req.system }],
    inferenceConfig: {
      maxTokens: req.maxTokens,
      // Only send temperature when explicitly set — Sonnet 5 rejects the
      // parameter as deprecated, while Nemotron accepts it.
      ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
    },
  };
  const tier = req.serviceTier ?? (req.model === BEDROCK_AGENT_MODEL ? BEDROCK_AGENT_TIER : undefined);
  if (tier && tierAllowedFor(req.model, tier)) body["serviceTier"] = { type: tier };
  if (req.tools?.length) {
    const toolConfig: Record<string, unknown> = {
      tools: [
        ...req.tools.map((t) => ({
          toolSpec: {
            name: t.name,
            description: t.description,
            inputSchema: { json: t.input_schema },
          },
        })),
        // Caches the whole tool block as one prefix.
        ...(req.cache ? [{ cachePoint: { type: "default" } }] : []),
      ],
    };
    toolConfig["toolChoice"] =
      typeof req.toolChoice === "object"
        ? { tool: { name: req.toolChoice.name } }
        : req.toolChoice === "any"
          ? { any: {} }
          : { auto: {} };
    body["toolConfig"] = toolConfig;
  }

  let res: Response;
  try {
    res = await signedBedrockFetch(endpoint(req.model), {
      body: JSON.stringify(body),
      ...(req.signal ? { signal: req.signal } : {}),
    });
  } catch (err) {
    // Network-level failure (DNS, reset, transient "fetch failed"). Status 0
    // is treated as retryable by bedrockChat below.
    throw new BedrockError(0, `Bedrock request failed: ${err instanceof Error ? err.message : "network error"}`);
  }

  if (!res.ok) {
    const retryAfterMs = retryAfterMsFrom(res);
    const detail = await res.text().catch(() => "");
    throw new BedrockError(
      res.status,
      `Bedrock request failed [${res.status}]: ${detail.slice(0, 400)}`,
      retryAfterMs,
    );
  }

  const json = (await res.json()) as {
    output?: { message?: { role?: string; content?: ContentBlock[] } };
    stopReason?: string;
    usage?: {
      inputTokens?: number;
      outputTokens?: number;
      cacheReadInputTokens?: number;
      cacheWriteInputTokens?: number;
    };
  };
  const blocks = json.output?.message?.content ?? [];
  const text = blocks
    .map((b) => ("text" in b ? b.text : ""))
    .join("")
    .trim();
  const toolCalls: BedrockToolCall[] = blocks
    .filter((b): b is Extract<ContentBlock, { toolUse: unknown }> => "toolUse" in b)
    .map((b) => ({
      id: b.toolUse.toolUseId,
      name: b.toolUse.name,
      input: (b.toolUse.input ?? {}) as Record<string, unknown>,
    }));

  return {
    text,
    toolCalls,
    raw: { role: "assistant", content: blocks },
    stopReason: json.stopReason ?? "end_turn",
    usage: {
      input: json.usage?.inputTokens ?? 0,
      output: json.usage?.outputTokens ?? 0,
      cacheRead: json.usage?.cacheReadInputTokens ?? 0,
      cacheWrite: json.usage?.cacheWriteInputTokens ?? 0,
    },
  };
}

/** converse with bounded backoff on 429 / 5xx. Everything else is terminal. */
export async function bedrockChat(
  req: BedrockChatRequest,
  retries = BEDROCK_MAX_RETRIES,
): Promise<BedrockChatResult> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await converseOnce(req);
    } catch (err) {
      lastErr = err;
      const aborted = req.signal?.aborted ?? false;
      const retryable =
        !aborted && err instanceof BedrockError && isRetryableBedrockStatus(err.status);
      if (retryable && attempt < retries) {
        const retryAfterMs = err instanceof BedrockError ? err.retryAfterMs : undefined;
        await new Promise((r) => setTimeout(r, bedrockRetryDelayMs(attempt, retryAfterMs)));
        continue;
      }
      throw err;
    }
  }
  throw lastErr;
}

/**
 * Tool-calling loop on Bedrock. Mirrors `runFireworksToolLoop` /`runToolLoop`
 * so the orchestrator's execute/announce callbacks are provider-agnostic.
 */
export async function runBedrockToolLoop(opts: {
  model: string;
  system: string;
  user: string;
  tools: BedrockToolDef[];
  maxTokens: number;
  maxSteps: number;
  temperature?: number;
  /** Cache the tools + system prefix across every turn (Claude models only). */
  cache?: boolean;
  signal?: AbortSignal;
  /** Hard, code-enforced caps on EXECUTED tool calls across the whole loop:
   *  perTool limits repeat calls to one named tool; total limits the round.
   *  Over-budget calls are not executed — the model gets a short notice as
   *  the tool result and is told to write from what it already has. */
  callBudget?: { perTool?: number; total?: number };
  /** Wall-clock budget for the whole loop. Checked between model turns (never
   *  aborts an in-flight call): once exceeded, no new turn is started and the
   *  loop finalizes a digest from whatever it already has. */
  deadlineMs?: number;
  /** Fires after every model turn with its timing and token usage. */
  onStep?: (step: {
    step: number;
    ms: number;
    stopReason: string;
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    toolCalls: string[];
  }) => void;
  execute: (call: BedrockToolCall) => Promise<string>;
  onToolUse?: (call: BedrockToolCall) => void;
}): Promise<{ text: string; steps: number }> {
  const messages: BedrockMsg[] = [userText(opts.user)];
  let text = "";
  let steps = 0;
  const perToolCap = opts.callBudget?.perTool ?? Number.POSITIVE_INFINITY;
  const totalCap = opts.callBudget?.total ?? Number.POSITIVE_INFINITY;
  const callCounts = new Map<string, number>();
  let totalCalls = 0;
  const deadline = opts.deadlineMs ? Date.now() + opts.deadlineMs : undefined;

  for (; steps < opts.maxSteps; steps++) {
    if (deadline && Date.now() > deadline) break;
    const stepStart = Date.now();
    const result = await bedrockChat({
      model: opts.model,
      system: opts.system,
      messages,
      tools: opts.tools,
      maxTokens: opts.maxTokens,
      ...(opts.cache ? { cache: true } : {}),
      ...(opts.temperature !== undefined ? { temperature: opts.temperature } : {}),
      ...(opts.signal ? { signal: opts.signal } : {}),
    });
    opts.onStep?.({
      step: steps + 1,
      ms: Date.now() - stepStart,
      stopReason: result.stopReason,
      inputTokens: result.usage.input,
      outputTokens: result.usage.output,
      cacheReadTokens: result.usage.cacheRead,
      cacheWriteTokens: result.usage.cacheWrite,
      toolCalls: result.toolCalls.map((t) => t.name),
    });
    if (result.text) text = result.text;
    if (!result.toolCalls.length) break;

    messages.push(result.raw);
    // Tool calls inside one assistant turn are independent — run them together.
    // Budget accounting happens synchronously (before any await), so parallel
    // execution cannot race past the caps.
    const outputs = await Promise.all(
      result.toolCalls.map((call) => {
        const used = callCounts.get(call.name) ?? 0;
        if (totalCalls >= totalCap) {
          return Promise.resolve({
            call,
            content: `TOOL BUDGET EXHAUSTED: this round's total tool-call budget (${totalCap}) is spent. Do not call any more tools — write your digest now from the results you already have.`,
            ok: true,
          });
        }
        if (used >= perToolCap) {
          return Promise.resolve({
            call,
            content: `TOOL BUDGET EXHAUSTED for ${call.name}: you have already called it ${used} times this round (cap ${perToolCap}). Do not call ${call.name} again — use a DIFFERENT tool or write your digest from the results you already have.`,
            ok: true,
          });
        }
        callCounts.set(call.name, used + 1);
        totalCalls++;
        opts.onToolUse?.(call);
        return (async () => {
          try {
            return { call, content: await opts.execute(call), ok: true };
          } catch (err) {
            return {
              call,
              content: `Tool error: ${err instanceof Error ? err.message : "failed"}`,
              ok: false,
            };
          }
        })();
      }),
    );
    messages.push({
      role: "user",
      content: outputs.map((o) => ({
        toolResult: {
          toolUseId: o.call.id,
          content: [{ text: o.content }],
          status: o.ok ? ("success" as const) : ("error" as const),
        },
      })),
    });
  }

  // The loop can exhaust its steps mid-research; ask for the digest explicitly.
  // toolConfig must stay on the request: the history carries toolUse/toolResult
  // blocks, and Bedrock rejects those when the tools are dropped.
  if (!text) {
    const final = await bedrockChat({
      model: opts.model,
      system: opts.system,
      messages: [
        ...messages,
        userText("Stop searching. Write your digest now from what you already found."),
      ],
      tools: opts.tools,
      maxTokens: opts.maxTokens,
      ...(opts.cache ? { cache: true } : {}),
      ...(opts.temperature !== undefined ? { temperature: opts.temperature } : {}),
      ...(opts.signal ? { signal: opts.signal } : {}),
    });
    text = final.text;
  }


  return { text, steps };
}
