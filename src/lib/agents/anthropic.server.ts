// ============================================================================
// Anthropic Messages API client (server-only).
//
// Every call streams: router / sub-agent / writer runs are long, and a
// buffered request gets severed by platform timeouts while still billing.
// ============================================================================

const API_URL = "https://api.anthropic.com/v1/messages";
const API_VERSION = "2023-06-01";

/** Claude Sonnet 5 — router planning (Anthropic fallback path). */
export const ROUTER_MODEL = "claude-sonnet-5";
/** Claude Sonnet 5 — research sub-agents. */
export const SUBAGENT_MODEL = "claude-sonnet-5";
/** Claude Sonnet 5 — the writer (Anthropic fallback path). */
export const WRITER_MODEL = "claude-sonnet-5";

export type Effort = "low" | "medium" | "high";

export type TextBlock = { type: "text"; text: string };
export type ThinkingBlock = { type: "thinking"; thinking: string; signature?: string };
export type ToolUseBlock = {
  type: "tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
};
export type ToolResultBlock = {
  type: "tool_result";
  tool_use_id: string;
  content: string;
  is_error?: boolean;
};
export type ContentBlock = TextBlock | ThinkingBlock | ToolUseBlock | ToolResultBlock;

export type Msg = { role: "user" | "assistant"; content: string | ContentBlock[] };

export type ToolDef = {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
};

export type StreamHandlers = {
  onText?: (delta: string) => void;
  onThinking?: (delta: string) => void;
  onToolUse?: (block: ToolUseBlock) => void;
};

export type StreamResult = {
  content: ContentBlock[];
  stopReason: string | null;
  text: string;
  toolUses: ToolUseBlock[];
};

export class AnthropicError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
    this.name = "AnthropicError";
  }
}

function apiKey(): string {
  const k = process.env["ANTHROPIC_API_KEY"];
  if (!k) throw new AnthropicError(401, "ANTHROPIC_API_KEY is not configured");
  return k;
}

export type StreamRequest = {
  model: string;
  system?: string;
  messages: Msg[];
  tools?: ToolDef[];
  toolChoice?: { type: "auto" } | { type: "any" } | { type: "tool"; name: string };
  maxTokens: number;
  /** Adaptive extended thinking; omit for no reasoning. */
  effort?: Effort;
  /** Deprecated on 5-gen models; ignored. */ temperature?: number;
  signal?: AbortSignal;
};

/** Stream one Messages API turn, surfacing deltas as they arrive. */
export async function streamMessage(
  req: StreamRequest,
  handlers: StreamHandlers = {},
): Promise<StreamResult> {
  const body: Record<string, unknown> = {
    model: req.model,
    max_tokens: req.maxTokens,
    messages: req.messages,
    stream: true,
  };
  if (req.system) body["system"] = req.system;
  if (req.tools?.length) body["tools"] = req.tools;
  if (req.toolChoice) body["tool_choice"] = req.toolChoice;
  if (req.effort) {
    // Opus/Sonnet 5-generation models use adaptive thinking + an effort dial.
    body["thinking"] = { type: "adaptive" };
    body["output_config"] = { effort: req.effort };
  }
  // Note: `temperature` is deprecated on the 5-generation models — never sent.


  const res = await fetch(API_URL, {
    method: "POST",
    headers: {
      "x-api-key": apiKey(),
      "anthropic-version": API_VERSION,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
    signal: req.signal,
  });

  if (!res.ok || !res.body) {
    let detail = "";
    try {
      detail = await res.text();
    } catch {
      /* ignore */
    }
    throw new AnthropicError(res.status, anthropicMessage(res.status, detail));
  }

  const blocks: ContentBlock[] = [];
  const partialJson: string[] = [];
  let stopReason: string | null = null;

  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let idx: number;
    while ((idx = buf.indexOf("\n\n")) !== -1) {
      const raw = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      const dataLines = raw
        .split("\n")
        .filter((l) => l.startsWith("data:"))
        .map((l) => l.slice(5).trim());
      if (!dataLines.length) continue;
      let evt: Record<string, unknown>;
      try {
        evt = JSON.parse(dataLines.join("\n")) as Record<string, unknown>;
      } catch {
        continue;
      }
      const type = String(evt["type"] ?? "");
      const i = Number(evt["index"] ?? 0);

      if (type === "content_block_start") {
        const cb = (evt["content_block"] ?? {}) as Record<string, unknown>;
        const t = String(cb["type"] ?? "text");
        if (t === "tool_use") {
          blocks[i] = {
            type: "tool_use",
            id: String(cb["id"] ?? ""),
            name: String(cb["name"] ?? ""),
            input: {},
          };
          partialJson[i] = "";
        } else if (t === "thinking") {
          blocks[i] = { type: "thinking", thinking: "" };
        } else {
          blocks[i] = { type: "text", text: "" };
        }
      } else if (type === "content_block_delta") {
        const d = (evt["delta"] ?? {}) as Record<string, unknown>;
        const dt = String(d["type"] ?? "");
        const b = blocks[i];
        if (dt === "text_delta" && b?.type === "text") {
          const piece = String(d["text"] ?? "");
          b.text += piece;
          handlers.onText?.(piece);
        } else if (dt === "thinking_delta" && b?.type === "thinking") {
          const piece = String(d["thinking"] ?? "");
          b.thinking += piece;
          handlers.onThinking?.(piece);
        } else if (dt === "signature_delta" && b?.type === "thinking") {
          b.signature = (b.signature ?? "") + String(d["signature"] ?? "");
        } else if (dt === "input_json_delta") {
          partialJson[i] = (partialJson[i] ?? "") + String(d["partial_json"] ?? "");
        }
      } else if (type === "content_block_stop") {
        const b = blocks[i];
        if (b?.type === "tool_use") {
          try {
            b.input = partialJson[i] ? (JSON.parse(partialJson[i]!) as Record<string, unknown>) : {};
          } catch {
            b.input = {};
          }
          handlers.onToolUse?.(b);
        }
      } else if (type === "message_delta") {
        const d = (evt["delta"] ?? {}) as Record<string, unknown>;
        if (d["stop_reason"]) stopReason = String(d["stop_reason"]);
      } else if (type === "error") {
        const e = (evt["error"] ?? {}) as Record<string, unknown>;
        throw new AnthropicError(500, String(e["message"] ?? "Anthropic stream error"));
      }
    }
  }

  const content = blocks.filter(Boolean);
  return {
    content,
    stopReason,
    text: content
      .filter((b): b is TextBlock => b.type === "text")
      .map((b) => b.text)
      .join(""),
    toolUses: content.filter((b): b is ToolUseBlock => b.type === "tool_use"),
  };
}

function anthropicMessage(status: number, detail: string): string {
  let msg = detail;
  try {
    const parsed = JSON.parse(detail) as { error?: { message?: string } };
    if (parsed.error?.message) msg = parsed.error.message;
  } catch {
    /* raw text */
  }
  if (status === 401) return "Anthropic rejected the API key. Check ANTHROPIC_API_KEY.";
  if (status === 429) return "Anthropic rate limit reached. Try again shortly.";
  if (status === 529) return "Anthropic is overloaded. Try again shortly.";
  if (status === 400 && /credit balance/i.test(msg))
    return "The Anthropic account is out of credit.";
  return msg || `Anthropic request failed (${status}).`;
}

/**
 * Run a tool-calling loop until the model stops asking for tools.
 * `execute` returns the string the model sees as the tool result.
 */
export async function runToolLoop(opts: {
  model: string;
  system: string;
  messages: Msg[];
  tools: ToolDef[];
  maxTokens: number;
  maxSteps: number;
  effort?: Effort;
  signal?: AbortSignal;
  execute: (call: ToolUseBlock) => Promise<string>;
  onToolUse?: (call: ToolUseBlock) => void;
  onText?: (delta: string) => void;
}): Promise<{ text: string; steps: number }> {
  const messages = [...opts.messages];
  let text = "";
  let steps = 0;

  for (; steps < opts.maxSteps; steps++) {
    const result = await streamMessage(
      {
        model: opts.model,
        system: opts.system,
        messages,
        tools: opts.tools,
        maxTokens: opts.maxTokens,
        effort: opts.effort,
        signal: opts.signal,
      },
      { onText: opts.onText },
    );
    if (result.text) text = result.text;
    if (!result.toolUses.length) break;

    messages.push({ role: "assistant", content: result.content });
    const results: ToolResultBlock[] = [];
    for (const call of result.toolUses) {
      opts.onToolUse?.(call);
      try {
        results.push({
          type: "tool_result",
          tool_use_id: call.id,
          content: await opts.execute(call),
        });
      } catch (err) {
        results.push({
          type: "tool_result",
          tool_use_id: call.id,
          content: `Tool error: ${err instanceof Error ? err.message : String(err)}`,
          is_error: true,
        });
      }
    }
    messages.push({ role: "user", content: results });
  }

  return { text, steps };
}
