// Temporary, explicit local synthetic transport. Production continues to use
// Bedrock. API protocols verified against the provider references:
// https://platform.claude.com/docs/en/build-with-claude/streaming
// https://docs.fireworks.ai/api-reference/post-chatcompletions
import { localSyntheticEnabled, type LocalEnvironment } from "@/lib/local-development";
import type { AgentImage, AgentMessage, AgentToolCall, AgentToolDef, RouteDecision, WriterProfile, WriterStreamCallbacks } from "./inference.server";

export type LocalOfficeProvider = "anthropic" | "fireworks";
export class LocalOfficeProviderError extends Error {
  status: number;
  constructor(status: number, message: string) { super(message); this.status = status; this.name = "LocalOfficeProviderError"; }
}
type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => v && typeof v === "object" && !Array.isArray(v) ? v as Obj : {};
const text = (v: unknown): string => typeof v === "string" ? v : "";
const count = (v: unknown): number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? v : 0;
const OPAQUE_REASONING_PREFIX = "sw-opaque-reasoning:";

function fireworksReasoning(value: string | undefined, model: string | undefined): string {
  if (!value || !model) return "";
  const at = value.indexOf(OPAQUE_REASONING_PREFIX);
  if (at < 0) return "";
  try {
    const parsed = obj(JSON.parse(value.slice(at + OPAQUE_REASONING_PREFIX.length)));
    return parsed.provider === "fireworks" && parsed.model === model ? text(parsed.reasoning_content) : "";
  } catch { return ""; }
}

export function officeLocalProvider(env: LocalEnvironment = process.env): LocalOfficeProvider | null {
  const provider = env.OFFICE_LOCAL_PROVIDER?.trim();
  if (!provider) return null;
  if (provider !== "anthropic" && provider !== "fireworks") throw new Error("Invalid OFFICE_LOCAL_PROVIDER.");
  if (!localSyntheticEnabled(env)) throw new Error("Direct Office providers require LOCAL_SYNTHETIC_MODE=1.");
  return provider;
}

export function officeLocalModel(provider: LocalOfficeProvider, route: RouteDecision, profile: WriterProfile, override?: string, env: LocalEnvironment = process.env): string {
  const prefix = `OFFICE_LOCAL_${provider.toUpperCase()}`;
  const specific = profile === "thorough" ? env[`${prefix}_THOROUGH_MODEL`]
    : route.tier !== "main" ? env[`${prefix}_FAST_MODEL`] : undefined;
  const model = (override ?? specific ?? env[`${prefix}_MODEL`])?.trim();
  if (!model) throw new Error(`${prefix}_MODEL must name an explicit direct API model.`);
  if (provider === "anthropic" ? !/^claude-[a-z0-9.-]+$/.test(model)
    : !/^accounts\/[a-zA-Z0-9_-]+\/(?:models|deployments)\/[a-zA-Z0-9_.-]+$/.test(model)) {
    throw new Error("Use a direct provider model ID; Bedrock IDs are not interchangeable.");
  }
  return model;
}

function anthropicImage(image: AgentImage): Obj {
  if (!/^image\/(png|jpeg|gif|webp)$/.test(image.mime)) throw new Error("Unsupported local image type.");
  return { type: "image", source: { type: "base64", media_type: image.mime, data: image.base64 } };
}

export function localProviderMessages(provider: LocalOfficeProvider, messages: AgentMessage[], model?: string): Obj[] {
  if (provider === "anthropic") return messages.map(m => {
    if (m.role === "tool") return { role: "user", content: m.results.map(r => ({
      type: "tool_result", tool_use_id: r.id, is_error: r.isError === true,
      content: [{ type: "text", text: r.output || "(empty result)" }, ...(r.images ?? []).map(anthropicImage)],
    })) };
    if (m.role === "user") return { role: "user", content: [
      ...(m.text ? [{ type: "text", text: m.text }] : []), ...(m.images ?? []).map(anthropicImage),
    ] };
    return { role: "assistant", content: [
      ...(m.text ? [{ type: "text", text: m.text }] : []),
      ...(m.toolCalls ?? []).map(c => ({ type: "tool_use", id: c.id, name: c.name, input: c.input })),
    ] };
  });
  const imagePart = (i: AgentImage): Obj => {
    anthropicImage(i); // shared MIME guard
    return { type: "image_url", image_url: { url: `data:${i.mime};base64,${i.base64}` } };
  };
  return messages.flatMap<Obj>(m => {
    if (m.role === "tool") return m.results.flatMap(r => [
      { role: "tool", tool_call_id: r.id, content: r.output || "(empty result)" },
      ...(r.images?.length ? [{ role: "user", content: [{ type: "text", text: `Images returned by tool ${r.id}` }, ...r.images.map(imagePart)] }] : []),
    ]);
    if (m.role === "user") return [{ role: "user", content: m.images?.length
      ? [{ type: "text", text: m.text || "Inspect the attached image." }, ...m.images.map(imagePart)] : m.text }];
    const reasoning = fireworksReasoning(m.reasoning, model);
    return [{ role: "assistant", content: m.text || null, ...(reasoning ? { reasoning_content: reasoning } : {}), ...(m.toolCalls?.length ? { tool_calls: m.toolCalls.map(c => ({
      id: c.id, type: "function", function: { name: c.name, arguments: JSON.stringify(c.input) },
    })) } : {}) }];
  });
}

/** SSE boundaries may straddle chunks; CRLF and multi-line data are legal. */
async function* events(body: ReadableStream<Uint8Array>, signal: AbortSignal): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let pending = "";
  const abort = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener("abort", abort, { once: true });
  try {
    for (;;) {
      signal.throwIfAborted();
      const { done, value } = await reader.read();
      signal.throwIfAborted();
      pending += decoder.decode(value, { stream: !done });
      if (pending.length > 4_000_000) throw new Error("Local provider event exceeds limit.");
      let match: RegExpExecArray | null;
      while ((match = /\r?\n\r?\n/.exec(pending))) {
        const frame = pending.slice(0, match.index);
        pending = pending.slice(match.index + match[0].length);
        const data = frame.split(/\r?\n/).filter(l => l.startsWith("data:")).map(l => l.slice(5).replace(/^ /, "")).join("\n");
        if (data) yield data;
      }
      if (done) {
        if (pending.trim()) throw new Error("Incomplete local provider event.");
        break;
      }
    }
  } finally {
    signal.removeEventListener("abort", abort);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

type PendingTool = { id: string; name: string; json: string; closed: boolean };
function completedCall(tool: PendingTool, allowed: Set<string>): AgentToolCall {
  if (!tool.id || !tool.name || !tool.closed) throw new Error("Incomplete local provider tool call.");
  if (!allowed.has(tool.name)) return { id: tool.id, name: tool.name, input: {}, inputError: "Tool is not allowed in this mode." };
  try {
    const input: unknown = JSON.parse(tool.json || "{}");
    if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("not an object");
    return { id: tool.id, name: tool.name, input: input as Obj };
  } catch { return { id: tool.id, name: tool.name, input: {}, inputError: "Tool arguments must be a complete JSON object." }; }
}

export async function streamOfficeLocalTurn(req: {
  provider: LocalOfficeProvider; route: RouteDecision; profile: WriterProfile;
  system: string; messages: AgentMessage[]; tools: AgentToolDef[];
  signal: AbortSignal; model?: string; fetchImpl?: typeof fetch;
}, cb: WriterStreamCallbacks): Promise<void> {
  if (officeLocalProvider() !== req.provider) throw new Error("Local provider selection mismatch.");
  req.signal.throwIfAborted();
  const model = officeLocalModel(req.provider, req.route, req.profile, req.model);
  const keyName = req.provider === "anthropic" ? "ANTHROPIC_API_KEY" : "FIREWORKS_API_KEY";
  const key = process.env[keyName]?.trim();
  if (!key) throw new Error(`${keyName} is required in the local process environment.`);
  const hasImages = req.messages.some(m => m.role === "user" ? m.images?.length : m.role === "tool" && m.results.some(r => r.images?.length));
  if (hasImages && req.provider === "fireworks" && process.env.OFFICE_LOCAL_FIREWORKS_VISION !== "1") {
    throw new Error("Fireworks vision must be explicitly enabled for a verified image-capable model.");
  }
  const max = Number(process.env.OFFICE_LOCAL_MAX_TOKENS || 8192);
  if (!Number.isSafeInteger(max) || max < 1 || max > 65536) throw new Error("Invalid OFFICE_LOCAL_MAX_TOKENS.");
  const anthropic = req.provider === "anthropic";
  const messages = localProviderMessages(req.provider, req.messages, model);
  const body = anthropic ? {
    model, system: req.system, messages, max_tokens: max, stream: true,
    ...(req.tools.length ? { tools: req.tools.map(t => ({ name: t.name, description: t.description, input_schema: t.inputSchema })) } : {}),
  } : {
    model, messages: [{ role: "system", content: req.system }, ...messages], max_tokens: max, stream: true,
    stream_options: { include_usage: true },
    ...(req.tools.length ? { tools: req.tools.map(t => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.inputSchema } })), tool_choice: "auto" } : {}),
  };
  const started = Date.now();
  cb.onStatus?.({ text: "Working in the local test workspace", model, tier: req.route.tier, taskClass: req.route.taskClass });
  const headers: Record<string, string> = { "Content-Type": "application/json", Accept: "text/event-stream" };
  if (anthropic) {
    headers["x-api-key"] = key;
    headers["anthropic-version"] = "2023-06-01";
    const workspace = process.env.OFFICE_LOCAL_ANTHROPIC_WORKSPACE_ID?.trim();
    if (workspace) headers["anthropic-workspace-id"] = workspace;
  } else headers.Authorization = `Bearer ${key}`;
  const response = await (req.fetchImpl ?? fetch)(anthropic ? "https://api.anthropic.com/v1/messages" : "https://api.fireworks.ai/inference/v1/chat/completions", {
    method: "POST", signal: req.signal, redirect: "error",
    headers,
    body: JSON.stringify(body),
  });
  if (!response.ok || !response.body) {
    await response.body?.cancel().catch(() => {});
    throw new LocalOfficeProviderError(response.status, `Local ${req.provider} request failed (HTTP ${response.status}).`);
  }
  const usage = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 };
  const pending = new Map<number, PendingTool>();
  let complete = false, stopReason = "", ttfbMs = 0, reasoning = "";
  for await (const data of events(response.body, req.signal)) {
    if (data === "[DONE]") { if (!anthropic) complete = true; break; }
    let event: Obj;
    try { event = obj(JSON.parse(data)); } catch { throw new Error("Malformed local provider event."); }
    if (event.type === "error" || event.error) throw new LocalOfficeProviderError(obj(event.error).type === "overloaded_error" ? 429 : 502, `Local ${req.provider} stream failed.`);
    if (!ttfbMs) ttfbMs = Math.max(1, Date.now() - started);
    if (anthropic) {
      if (/^content_block_/.test(text(event.type)) && (!Number.isSafeInteger(event.index) || (event.index as number) < 0)) throw new Error("Invalid local content block index.");
      const index = count(event.index);
      const block = obj(event.content_block), delta = obj(event.delta);
      if (event.type === "message_start") {
        const u = obj(obj(event.message).usage);
        usage.inputTokens = count(u.input_tokens); usage.cacheReadTokens = count(u.cache_read_input_tokens); usage.cacheWriteTokens = count(u.cache_creation_input_tokens);
      } else if (event.type === "content_block_start" && block.type === "tool_use") {
        if (pending.has(index)) throw new Error("Duplicate local tool index.");
        pending.set(index, { id: text(block.id), name: text(block.name), json: "", closed: false });
      } else if (event.type === "content_block_delta") {
        if (delta.type === "text_delta") cb.onDelta(text(delta.text));
        else if (delta.type === "input_json_delta") {
          const tool = pending.get(index);
          if (!tool || tool.closed) throw new Error("Unexpected local tool delta.");
          tool.json += text(delta.partial_json);
          if (tool.json.length > 2_000_000) throw new Error("Local tool arguments exceed limit.");
        }
      } else if (event.type === "content_block_stop") {
        const tool = pending.get(index); if (tool) tool.closed = true;
      } else if (event.type === "message_delta") {
        stopReason = text(delta.stop_reason); usage.outputTokens = count(obj(event.usage).output_tokens);
      } else if (event.type === "message_stop") { complete = true; break; }
    } else {
      const choices = Array.isArray(event.choices) ? event.choices : [];
      for (const c of choices) {
        const choice = obj(c), delta = obj(choice.delta);
        reasoning += text(delta.reasoning_content);
        if (reasoning.length > 2_000_000) throw new Error("Local reasoning payload exceeds limit.");
        if (text(delta.content)) cb.onDelta(text(delta.content));
        if (typeof choice.finish_reason === "string") stopReason = choice.finish_reason;
        for (const raw of Array.isArray(delta.tool_calls) ? delta.tool_calls : []) {
          const call = obj(raw), fn = obj(call.function);
          if (!Number.isSafeInteger(call.index) || (call.index as number) < 0) throw new Error("Invalid local tool index.");
          const index = call.index as number;
          const tool = pending.get(index) ?? { id: "", name: "", json: "", closed: true };
          tool.id += text(call.id); tool.name += text(fn.name); tool.json += text(fn.arguments);
          if (tool.json.length > 2_000_000) throw new Error("Local tool arguments exceed limit.");
          pending.set(index, tool);
        }
      }
      if (event.usage) {
        const u = obj(event.usage); usage.inputTokens = count(u.prompt_tokens); usage.outputTokens = count(u.completion_tokens);
      }
    }
  }
  req.signal.throwIfAborted();
  if (!complete || !stopReason) throw new Error("Local provider stream ended before completion; no tools were dispatched.");
  const normalizedStop = stopReason === "tool_calls" ? "tool_use" : stopReason === "length" ? "max_tokens" : stopReason === "stop" ? "end_turn" : stopReason;
  const calls = [...pending.values()].map(t => completedCall(t, new Set(req.tools.map(t => t.name))));
  if (new Set(calls.map(c => c.id)).size !== calls.length) throw new Error("Duplicate local provider tool IDs.");
  // Never execute a partial or stopped/refused generation's plausible prefix.
  if (calls.length && normalizedStop !== "tool_use") throw new Error("Local provider did not complete its tool turn; no tools were dispatched.");
  // Fireworks interleaved-thinking models require this on tool-result follow-ups.
  // Reuse the UI's opaque envelope and bind it to the producing provider/model;
  // never expose raw reasoning as a text delta or replay it to another model.
  if (!anthropic && reasoning) cb.onReasoning(`${OPAQUE_REASONING_PREFIX}${JSON.stringify({ provider: "fireworks", model, reasoning_content: reasoning })}`);
  cb.onStopReason(normalizedStop);
  cb.onUsage?.({ ...usage, model, tier: req.route.tier, ttfbMs });
  for (const call of calls) cb.onToolCall(call);
}
