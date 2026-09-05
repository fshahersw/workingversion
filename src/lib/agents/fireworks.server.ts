// ============================================================================
// Fireworks AI client (server-only).
//
// Fireworks serves an OpenAI-compatible chat API. The summarizer uses it for
// the high-volume reading passes (section digests + targeted sweeps), where
// throughput and price matter more than prose quality. Claude still writes
// the memo. If FIREWORKS_API_KEY is not configured every caller falls back to
// Claude, so runs never break because the key is missing.
// ============================================================================

const API_URL = "https://api.fireworks.ai/inference/v1/chat/completions";

/**
 * Fast, cheap long-context reader used for section digests and sweeps in the
 * fast/standard modes. Benchmarked at ~2.3s median on a 58k-char section.
 */
export const FIREWORKS_DIGEST_MODEL = "accounts/fireworks/models/nemotron-lightning-3p5-30b-a3b";

/**
 * Slower but stricter reader used in thorough mode: perfect JSON-format
 * compliance and tighter, less noisy fact lists (~10s median per section).
 */
export const FIREWORKS_PRECISE_MODEL = "accounts/fireworks/models/kimi-k3";

export class FireworksError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
    this.name = "FireworksError";
  }
}

export function fireworksEnabled(): boolean {
  return !!process.env["FIREWORKS_API_KEY"];
}

export type FireworksRequest = {
  model: string;
  system: string;
  user: string;
  maxTokens: number;
  temperature?: number;
  signal?: AbortSignal;
};

async function once(req: FireworksRequest): Promise<string> {
  const key = process.env["FIREWORKS_API_KEY"];
  if (!key) throw new FireworksError(401, "FIREWORKS_API_KEY is not configured");

  const res = await fetch(API_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: req.model,
      max_tokens: req.maxTokens,
      temperature: req.temperature ?? 0.2,
      // Reading passes are extraction work: keep the model out of thinking mode
      // so the response body is the digest, not a chain of thought.
      reasoning_effort: "none",
      messages: [
        { role: "system", content: req.system },
        { role: "user", content: req.user },
      ],
    }),
    ...(req.signal ? { signal: req.signal } : {}),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new FireworksError(res.status, `Fireworks request failed [${res.status}]: ${body.slice(0, 400)}`);
  }

  const json = (await res.json()) as {
    choices?: { message?: { content?: string } }[];
  };
  return json.choices?.[0]?.message?.content ?? "";
}

/** Chat completion with bounded backoff on 429 / 5xx. */
export async function fireworksComplete(req: FireworksRequest, retries = 3): Promise<string> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await once(req);
    } catch (err) {
      lastErr = err;
      const retryable =
        err instanceof FireworksError && (err.status === 429 || err.status >= 500);
      if (retryable && attempt < retries) {
        await new Promise((r) => setTimeout(r, Math.min(1_500 * 2 ** attempt, 8_000)));
        continue;
      }
      throw err;
    }
  }
  throw lastErr;
}

// ============================================================================
// Tool-calling support (OpenAI-compatible) so the research router and
// sub-agents can run on Fireworks with the same tool contract as Claude.
// ============================================================================

/**
 * Kimi K3 — the research router and sub-agent model. Chosen over the lightning
 * reader because it emits perfectly-formed tool calls and structured JSON.
 */
export const FIREWORKS_AGENT_MODEL = "accounts/fireworks/models/kimi-k3";

type OpenAIMsg = {
  role: "system" | "user" | "assistant" | "tool";
  content?: string | null;
  tool_calls?: { id: string; type: "function"; function: { name: string; arguments: string } }[];
  tool_call_id?: string;
};

export type FireworksToolDef = {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
};

export type FireworksToolCall = {
  id: string;
  name: string;
  input: Record<string, unknown>;
};

export type FireworksChatRequest = {
  model: string;
  messages: OpenAIMsg[];
  tools?: FireworksToolDef[];
  /** Force a specific tool, or any tool. */
  toolChoice?: "auto" | "required" | { name: string };
  maxTokens: number;
  temperature?: number;
  signal?: AbortSignal;
};

export type FireworksChatResult = {
  text: string;
  toolCalls: FireworksToolCall[];
  raw: OpenAIMsg;
};

async function chatOnce(req: FireworksChatRequest): Promise<FireworksChatResult> {
  const key = process.env["FIREWORKS_API_KEY"];
  if (!key) throw new FireworksError(401, "FIREWORKS_API_KEY is not configured");

  const body: Record<string, unknown> = {
    model: req.model,
    max_tokens: req.maxTokens,
    temperature: req.temperature ?? 0.2,
    reasoning_effort: "none",
    messages: req.messages,
  };
  if (req.tools?.length) {
    body["tools"] = req.tools.map((t) => ({
      type: "function",
      function: { name: t.name, description: t.description, parameters: t.input_schema },
    }));
    body["tool_choice"] =
      typeof req.toolChoice === "object"
        ? { type: "function", function: { name: req.toolChoice.name } }
        : (req.toolChoice ?? "auto");
  }

  const res = await fetch(API_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
    ...(req.signal ? { signal: req.signal } : {}),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new FireworksError(res.status, `Fireworks request failed [${res.status}]: ${detail.slice(0, 400)}`);
  }

  const json = (await res.json()) as { choices?: { message?: OpenAIMsg }[] };
  const msg = json.choices?.[0]?.message ?? { role: "assistant", content: "" };
  const toolCalls: FireworksToolCall[] = (msg.tool_calls ?? []).map((c) => {
    let input: Record<string, unknown> = {};
    try {
      input = JSON.parse(c.function.arguments || "{}") as Record<string, unknown>;
    } catch {
      input = {};
    }
    return { id: c.id, name: c.function.name, input };
  });
  return { text: typeof msg.content === "string" ? msg.content : "", toolCalls, raw: msg };
}

/** Tool-capable chat completion with bounded backoff on 429 / 5xx. */
export async function fireworksChat(
  req: FireworksChatRequest,
  retries = 2,
): Promise<FireworksChatResult> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await chatOnce(req);
    } catch (err) {
      lastErr = err;
      const retryable = err instanceof FireworksError && (err.status === 429 || err.status >= 500);
      if (retryable && attempt < retries) {
        await new Promise((r) => setTimeout(r, Math.min(1_200 * 2 ** attempt, 6_000)));
        continue;
      }
      throw err;
    }
  }
  throw lastErr;
}

/**
 * Run a tool-calling loop on Fireworks until the model stops asking for tools.
 * Mirrors `runToolLoop` in anthropic.server.ts so callers can swap providers.
 */
export async function runFireworksToolLoop(opts: {
  model: string;
  system: string;
  user: string;
  tools: FireworksToolDef[];
  maxTokens: number;
  maxSteps: number;
  signal?: AbortSignal;
  execute: (call: FireworksToolCall) => Promise<string>;
  onToolUse?: (call: FireworksToolCall) => void;
}): Promise<{ text: string; steps: number }> {
  const messages: OpenAIMsg[] = [
    { role: "system", content: opts.system },
    { role: "user", content: opts.user },
  ];
  let text = "";
  let steps = 0;

  for (; steps < opts.maxSteps; steps++) {
    const result = await fireworksChat({
      model: opts.model,
      messages,
      tools: opts.tools,
      maxTokens: opts.maxTokens,
      ...(opts.signal ? { signal: opts.signal } : {}),
    });
    if (result.text) text = result.text;
    if (!result.toolCalls.length) break;

    messages.push(result.raw);
    // Tool calls in one assistant turn are independent — run them together.
    const outputs = await Promise.all(
      result.toolCalls.map(async (call) => {
        opts.onToolUse?.(call);
        try {
          return { call, content: await opts.execute(call) };
        } catch (err) {
          return {
            call,
            content: `Tool error: ${err instanceof Error ? err.message : "failed"}`,
          };
        }
      }),
    );
    for (const o of outputs) {
      messages.push({ role: "tool", tool_call_id: o.call.id, content: o.content });
    }
  }

  // The loop can exhaust its steps mid-research; ask for the digest explicitly.
  if (!text) {
    const final = await fireworksChat({
      model: opts.model,
      messages: [...messages, { role: "user", content: "Write your digest now from what you found." }],
      maxTokens: opts.maxTokens,
      ...(opts.signal ? { signal: opts.signal } : {}),
    });
    text = final.text;
  }

  return { text, steps };
}
