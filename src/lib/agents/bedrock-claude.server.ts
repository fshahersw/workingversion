// ============================================================================
// Final writer agent on AWS Bedrock (server-only).
//
// Two streaming paths share one AWS event-stream frame decoder:
//
//  1. Anthropic Claude (e.g. us.anthropic.claude-sonnet-5) via
//     `invoke-with-response-stream`. Each frame wraps one Anthropic SSE event
//     as { "bytes": "<base64>" }. Supports adaptive thinking + effort.
//
//  2. Converse-compatible models (e.g. zai.glm-5) via `converse-stream`. Each
//     frame carries a Converse event JSON directly (no base64 wrapper). No
//     adaptive-thinking channel — reasoning, if any, arrives inline as text.
//
// Both are SigV4-signed via the default credential chain (see
// bedrock-sign.server.ts) over raw HTTPS — no static bearer token. Signing the
// request does not affect the streamed response, so the frame decoder below is
// unchanged.
//
// `streamWriter` routes to the right path by model id. The writer model is
// env-driven: set BEDROCK_WRITER_MODEL to override the Sonnet 5 default
// (e.g. BEDROCK_WRITER_MODEL=zai.glm-5).
//
// Verified Anthropic constraints (see the Sonnet 5 Bedrock reference):
//  - the bare model id is rejected; an inference profile id is required.
//  - `temperature` may not be sent while adaptive thinking is on.
//  - max_tokens is SHARED between invisible reasoning and the visible answer,
//    so it must be sized generously or the answer comes back empty.
// ============================================================================
import { signedBedrockFetch, bedrockCredsReady } from "@/lib/agents/bedrock-sign.server";

const REGION = process.env["BEDROCK_REGION"] ?? "us-east-1";

/** Default writer — the 5-series requires a profile id, not a bare model id. */
const WRITER_DEFAULT = "us.anthropic.claude-sonnet-5";

/**
 * Active writer model. Override via env (BEDROCK_WRITER_MODEL), e.g.
 * `zai.glm-5` to run the Converse path instead of Anthropic Claude.
 */
export const BEDROCK_WRITER_MODEL = process.env["BEDROCK_WRITER_MODEL"] || WRITER_DEFAULT;

/**
 * Pile Ask writer — Sonnet 5 on Bedrock (inference-profile id required).
 * Override with BEDROCK_PILE_WRITER_MODEL. Research still uses Opus 5.
 */
export const BEDROCK_PILE_WRITER_MODEL =
  process.env["BEDROCK_PILE_WRITER_MODEL"] || "us.anthropic.claude-sonnet-5";

export type BedrockEffort = "low" | "medium" | "high" | "xhigh" | "max";

export class BedrockClaudeError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
    this.name = "BedrockClaudeError";
  }
}

export function bedrockClaudeEnabled(): boolean {
  return bedrockCredsReady();
}

/** True when the model runs the Anthropic invoke path; false → Converse path. */
export function isAnthropicWriter(model: string = BEDROCK_WRITER_MODEL): boolean {
  return /anthropic|claude/i.test(model);
}

export type BedrockImageMediaType = "image/jpeg" | "image/png" | "image/webp";

export type BedrockImage = { mediaType: BedrockImageMediaType; data: string };

export type BedrockClaudeMsg = {
  role: "user" | "assistant";
  content: string;
  /** Base64 page images placed before the text (vision re-read of scanned pages). */
  images?: BedrockImage[];
};

function converseImageFormat(mediaType: BedrockImageMediaType): "jpeg" | "png" | "webp" {
  return mediaType === "image/png" ? "png" : mediaType === "image/webp" ? "webp" : "jpeg";
}

export type BedrockClaudeRequest = {
  model?: string;
  system: string;
  messages: BedrockClaudeMsg[];
  /** Shared across thinking + answer on the Anthropic path. Never below 8000. */
  maxTokens: number;
  effort?: BedrockEffort;
  signal?: AbortSignal;
};

// ---------------------------------------------------------------------------
// AWS event-stream framing (shared by both paths)
//
// [ 4B total len ][ 4B headers len ][ 4B prelude CRC ][ headers ][ payload ][ 4B CRC ]
// Anthropic invoke payload: { "bytes": "<base64 of the Anthropic event>" }.
// Converse-stream payload:  the Converse event JSON, verbatim.
// ---------------------------------------------------------------------------

type Bytes = Uint8Array<ArrayBufferLike>;

function decodeFrames(buf: Bytes): { events: string[]; rest: Bytes } {
  const events: string[] = [];
  let offset = 0;
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);

  while (buf.byteLength - offset >= 16) {
    const total = view.getUint32(offset);
    if (!Number.isFinite(total) || total <= 0 || total > 64 * 1024 * 1024) {
      // Desynchronised — drop what we have rather than spin forever.
      return { events, rest: new Uint8Array(0) };
    }
    if (buf.byteLength - offset < total) break;
    const headersLen = view.getUint32(offset + 4);
    const payloadStart = offset + 12 + headersLen;
    const payloadEnd = offset + total - 4;
    if (payloadEnd > payloadStart) {
      const payload = buf.subarray(payloadStart, payloadEnd);
      events.push(new TextDecoder().decode(payload));
    }
    offset += total;
  }
  return { events, rest: buf.subarray(offset) };
}

function concat(a: Bytes, b: Bytes): Bytes {
  const out = new Uint8Array(a.byteLength + b.byteLength);
  out.set(a, 0);
  out.set(b, a.byteLength);
  return out;
}

function base64ToText(b64: string): string {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

function invokeEndpoint(model: string): string {
  return `https://bedrock-runtime.${REGION}.amazonaws.com/model/${encodeURIComponent(
    model,
  )}/invoke-with-response-stream`;
}

function converseStreamEndpoint(model: string): string {
  return `https://bedrock-runtime.${REGION}.amazonaws.com/model/${encodeURIComponent(
    model,
  )}/converse-stream`;
}

export type BedrockClaudeResult = {
  text: string;
  stopReason: string | null;
  /** Reasoning tokens billed inside max_tokens, when Bedrock reports them. */
  thinkingTokens: number;
};

// ---------------------------------------------------------------------------
// Path 1: Anthropic Claude via invoke-with-response-stream.
// ---------------------------------------------------------------------------

/**
 * Stream one Anthropic Claude turn from Bedrock, surfacing visible text deltas.
 *
 * Throws when the stream completes with no visible text — on this deployment
 * that means reasoning consumed the entire budget, which is a truncation bug,
 * not a valid empty answer.
 */
export async function streamBedrockClaude(
  req: BedrockClaudeRequest,
  handlers: { onText?: (delta: string) => void } = {},
): Promise<BedrockClaudeResult> {
  const body: Record<string, unknown> = {
    anthropic_version: "bedrock-2023-05-31",
    // Never below 12k: thinking and the answer share this budget.
    max_tokens: Math.max(req.maxTokens, 12000),
    system: req.system,
    messages: req.messages.map((m) => ({
      role: m.role,
      content: [
        ...(m.images ?? []).map((image) => ({
          type: "image",
          source: { type: "base64", media_type: image.mediaType, data: image.data },
        })),
        { type: "text", text: m.content },
      ],
    })),
    thinking: { type: "adaptive" },
    output_config: { effort: req.effort ?? "medium" },
    // No `temperature`: Bedrock rejects any value but 1 while thinking is on.
  };

  const res = await signedBedrockFetch(invokeEndpoint(req.model ?? BEDROCK_WRITER_MODEL), {
    headers: { accept: "application/vnd.amazon.eventstream" },
    body: JSON.stringify(body),
    ...(req.signal ? { signal: req.signal } : {}),
  });

  if (!res.ok || !res.body) {
    const detail = await res.text().catch(() => "");
    throw new BedrockClaudeError(
      res.status,
      `Bedrock Claude request failed [${res.status}]: ${detail.slice(0, 400)}`,
    );
  }

  const reader = res.body.getReader();
  let pending: Bytes = new Uint8Array(0);
  let text = "";
  let stopReason: string | null = null;
  let thinkingTokens = 0;

  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    if (!value) continue;
    pending = concat(pending, value);
    const { events, rest } = decodeFrames(pending);
    pending = rest;

    for (const raw of events) {
      let outer: Record<string, unknown>;
      try {
        outer = JSON.parse(raw) as Record<string, unknown>;
      } catch {
        continue;
      }
      const b64 = outer["bytes"];
      if (typeof b64 !== "string") {
        // Bedrock surfaces modelStream / throttling exceptions as a bare
        // { message } frame with no base64 payload.
        const errMsg = outer["message"] ?? outer["Message"];
        if (typeof errMsg === "string" && errMsg) {
          throw new BedrockClaudeError(500, `Bedrock Claude stream error: ${errMsg}`);
        }
        continue;
      }
      let evt: Record<string, unknown>;
      try {
        evt = JSON.parse(base64ToText(b64)) as Record<string, unknown>;
      } catch {
        continue;
      }
      const type = String(evt["type"] ?? "");
      if (type === "content_block_delta") {
        const d = (evt["delta"] ?? {}) as Record<string, unknown>;
        if (String(d["type"] ?? "") === "text_delta") {
          const piece = String(d["text"] ?? "");
          if (piece) {
            text += piece;
            handlers.onText?.(piece);
          }
        }
        // signature_delta carries no human-readable reasoning — ignored.
      } else if (type === "message_delta") {
        const d = (evt["delta"] ?? {}) as Record<string, unknown>;
        if (d["stop_reason"]) stopReason = String(d["stop_reason"]);
        const usage = (evt["usage"] ?? {}) as Record<string, unknown>;
        const details = (usage["output_tokens_details"] ?? {}) as Record<string, unknown>;
        const t = Number(details["thinking_tokens"] ?? 0);
        if (Number.isFinite(t) && t > thinkingTokens) thinkingTokens = t;
      } else if (type === "error") {
        const e = (evt["error"] ?? {}) as Record<string, unknown>;
        throw new BedrockClaudeError(
          500,
          `Bedrock Claude stream error: ${String(e["message"] ?? "unknown")}`,
        );
      }
    }
  }

  if (!text.trim()) {
    throw new BedrockClaudeError(
      502,
      "Bedrock Claude returned no visible text (reasoning consumed the token budget).",
    );
  }

  return { text, stopReason, thinkingTokens };
}

// ---------------------------------------------------------------------------
// Path 2: Converse-compatible models (e.g. zai.glm-5) via converse-stream.
//
// Converse-stream frames carry the event JSON directly. There is no separate
// reasoning channel: `delta.text` is the visible answer; `delta.reasoningContent`
// (if a model emits it) is dropped so it never pollutes the answer body.
// ---------------------------------------------------------------------------

export async function streamBedrockConverse(
  req: BedrockClaudeRequest,
  handlers: { onText?: (delta: string) => void } = {},
): Promise<BedrockClaudeResult> {
  const model = req.model ?? BEDROCK_WRITER_MODEL;
  const body: Record<string, unknown> = {
    system: [{ text: req.system }],
    messages: req.messages.map((m) => ({
      role: m.role,
      content: [
        ...(m.images ?? []).map((image) => ({
          image: { format: converseImageFormat(image.mediaType), source: { bytes: image.data } },
        })),
        { text: m.content },
      ],
    })),
    inferenceConfig: { maxTokens: Math.max(req.maxTokens, 1536) },
  };

  const res = await signedBedrockFetch(converseStreamEndpoint(model), {
    headers: { accept: "application/vnd.amazon.eventstream" },
    body: JSON.stringify(body),
    ...(req.signal ? { signal: req.signal } : {}),
  });

  if (!res.ok || !res.body) {
    const detail = await res.text().catch(() => "");
    throw new BedrockClaudeError(
      res.status,
      `Bedrock Converse request failed [${res.status}] (${model}): ${detail.slice(0, 400)}`,
    );
  }

  const reader = res.body.getReader();
  let pending: Bytes = new Uint8Array(0);
  let text = "";
  let stopReason: string | null = null;

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

      // Text delta (contentBlockDelta).
      const delta = evt["delta"];
      if (delta && typeof delta === "object") {
        const d = delta as Record<string, unknown>;
        const piece = d["text"];
        if (typeof piece === "string" && piece) {
          text += piece;
          handlers.onText?.(piece);
        }
        // d["reasoningContent"] is intentionally dropped from the answer body.
        continue;
      }

      // Stop reason (messageStop).
      if (typeof evt["stopReason"] === "string") {
        stopReason = String(evt["stopReason"]);
        continue;
      }

      // Exception frames (throttling / validation / modelStream) arrive as a
      // bare { message } payload once the header is stripped. messageStart
      // (role) and metadata (usage/metrics) frames are not errors.
      if (evt["role"] === undefined && evt["usage"] === undefined && evt["metrics"] === undefined) {
        const errMsg = evt["message"] ?? evt["Message"];
        if (typeof errMsg === "string" && errMsg) {
          throw new BedrockClaudeError(500, `Bedrock Converse stream error (${model}): ${errMsg}`);
        }
      }
    }
  }

  if (!text.trim()) {
    throw new BedrockClaudeError(
      502,
      `Bedrock Converse model ${model} returned no visible text.`,
    );
  }

  return { text, stopReason, thinkingTokens: 0 };
}

// ---------------------------------------------------------------------------
// Dispatcher: pick the streaming path by model id.
// ---------------------------------------------------------------------------

export async function streamWriter(
  req: BedrockClaudeRequest,
  handlers: { onText?: (delta: string) => void } = {},
): Promise<BedrockClaudeResult> {
  const model = req.model ?? BEDROCK_WRITER_MODEL;
  return isAnthropicWriter(model)
    ? streamBedrockClaude({ ...req, model }, handlers)
    : streamBedrockConverse({ ...req, model }, handlers);
}
