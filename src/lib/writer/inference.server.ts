// ============================================================================
// Writer assistant inference (server-only). One model turn of the Writer's
// browser-side agent loop: the renderer sends {system, messages, tools}; this
// streams the reply from Bedrock Converse and hands back text deltas, opaque
// reasoning, and complete tool calls. Tool EXECUTION stays in the browser
// (document tools run against the live editor; web_search calls back into the
// platform). The server only enforces the per-mode tool allow-list.
//
// Ported from the Office server's sw-connection/sw-conversation (Converse path)
// onto the platform's SigV4 fetch and event-stream decoder.
// ============================================================================
import {
  BedrockClaudeError,
  concat,
  converseStreamEndpoint,
  decodeFrames,
  type Bytes,
} from "@/lib/agents/bedrock-claude.server";
import { signedBedrockFetch } from "@/lib/agents/bedrock-sign.server";

export type WriterProfile = "standard" | "thorough";
export type WriterMode = "write" | "ask" | "review" | "research";

export const WRITER_MODEL =
  process.env["WRITER_BEDROCK_MODEL"] ||
  process.env["BEDROCK_RESEARCH_MODEL"] ||
  "us.anthropic.claude-sonnet-5";

const MAX_TOKENS: Record<WriterProfile, number> = { standard: 8192, thorough: 16384 };

/**
 * Adaptive-thinking effort per profile. Defaults: a light budget for
 * Standard (tool-call accuracy without a latency hit), a high budget for
 * Thorough. `WRITER_THINKING_EFFORT` overrides both; `off` disables thinking.
 */
const THINKING_LEVELS = new Set(["low", "medium", "high", "max"]);
function thinkingEffort(profile: WriterProfile): string {
  const global = (process.env["WRITER_THINKING_EFFORT"] ?? "").trim().toLowerCase();
  const perProfile = (
    process.env[`WRITER_THINKING_EFFORT_${profile.toUpperCase()}`] ?? ""
  )
    .trim()
    .toLowerCase();
  const value = global || perProfile || (profile === "thorough" ? "high" : "low");
  return THINKING_LEVELS.has(value) ? value : "";
}

/**
 * Prompt caching. The system prompt, the tool schemas and the conversation
 * prefix are identical from one tool round to the next, so mark each as a
 * Bedrock cache checkpoint: cached input is read at a fraction of the price
 * and the time-to-first-token of every follow-up round drops with it.
 * Segments below the model's minimum cacheable size are simply not cached.
 * Disable with WRITER_PROMPT_CACHE=off.
 */
const PROMPT_CACHE = (process.env["WRITER_PROMPT_CACHE"] ?? "on").toLowerCase() !== "off";
const CACHE_POINT = { cachePoint: { type: "default" } };

// --- Tool policy (mirrors each app's src/shared/sw-policy.ts) ----------------------

export type OfficeApp = "writer" | "sheets" | "slides";

export function isOfficeApp(v: unknown): v is OfficeApp {
  return v === "writer" || v === "sheets" || v === "slides";
}

// Platform-executed tools (src/office/shared/platform-skill.ts): none of them
// changes the open document, so every mode may call them.
const PLATFORM_READ = [
  "run_python",
  "verify_citations",
  "fetch_page",
  "load_firm_guide",
  "ask_clarification",
  "render_diagram",
  "generate_image",
];

const WRITER_READ = [
  ...PLATFORM_READ,
  "get_document_context",
  "read_blocks",
  "read_revisions",
  "read_comments",
  "read_attachment",
  "web_search",
];
const WRITER_WRITE = [
  ...WRITER_READ,
  "insert_content",
  "replace_blocks",
  "apply_commands",
  "insert_chart",
  "edit_chart",
  "insert_image",
  "set_header_footer",
  "reply_comment",
  "resolve_comment",
  "create_document",
];

// Sheets cannot embed generated images (the engine's add_image path is
// path-based and blocked at the boundary), so the image tools stay out.
const SHEETS_READ = [
  ...PLATFORM_READ.filter((n) => n !== "render_diagram" && n !== "generate_image"),
  "get_workbook_context",
  "read_range",
  "aggregate_range",
  "load_guide",
  "read_formats",
  "read_sheet_features",
  "read_cells",
  "find_cells",
  "select_range",
  "trace_precedents",
  "trace_dependents",
  "read_attachment",
  "web_search",
];
const SHEETS_WRITE = [...SHEETS_READ, "propose_operations", "create_document"];

const SLIDES_READ = [
  ...PLATFORM_READ,
  "read_slide",
  "load_guide",
  "read_attachment",
  "list_slide_templates",
  "audit_layout",
  "list_style_templates",
  "web_search",
];
const SLIDES_WRITE = [
  ...SLIDES_READ,
  "execute_slide_script",
  "add_slide",
  "edit_table_style",
  "edit_chart",
  "apply_ops",
  "save_style_template",
  "create_presentation",
  "insert_web_image",
  "replace_image",
  "create_document",
];

const POLICY: Record<OfficeApp, { read: string[]; write: string[] }> = {
  writer: { read: WRITER_READ, write: WRITER_WRITE },
  sheets: { read: SHEETS_READ, write: SHEETS_WRITE },
  slides: { read: SLIDES_READ, write: SLIDES_WRITE },
};

export function allowedToolNames(mode: WriterMode, app: OfficeApp = "writer"): Set<string> {
  if (mode === "research") return new Set(["web_search"]);
  const policy = POLICY[app];
  return new Set(mode === "write" ? policy.write : policy.read);
}

export function isWriterMode(v: unknown): v is WriterMode {
  return v === "write" || v === "ask" || v === "review" || v === "research";
}
export function isWriterProfile(v: unknown): v is WriterProfile {
  return v === "standard" || v === "thorough";
}

// --- Agent message wire types (mirrors @genoffice/agent-core) -----------------------

export type AgentToolDef = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
};
export type AgentToolCall = {
  id: string;
  name: string;
  input: Record<string, unknown>;
  inputError?: string;
  truncated?: boolean;
};
export type AgentImage = { base64: string; mime: string };
export type AgentMessage =
  | { role: "user"; text: string; images?: AgentImage[] }
  | { role: "assistant"; text: string; toolCalls?: AgentToolCall[]; reasoning?: string }
  | {
      role: "tool";
      results: Array<{ id: string; name: string; output: string; isError?: boolean }>;
    };

const REASONING_PREFIX = "sw-opaque-reasoning:";

/** Pack Converse reasoning blocks into the opaque string the renderer echoes back. */
export function packReasoning(blocks: unknown[]): string {
  return REASONING_PREFIX + JSON.stringify(blocks);
}

function reasoningBlocks(value: unknown): unknown[] {
  if (typeof value !== "string" || !value.startsWith(REASONING_PREFIX)) return [];
  try {
    const b = JSON.parse(value.slice(REASONING_PREFIX.length));
    return Array.isArray(b) ? b : [];
  } catch {
    return [];
  }
}

export type ConversationBody = {
  system: string;
  messages: AgentMessage[];
  tools?: AgentToolDef[];
};

/** Bound and shape-check the renderer's conversation payload; throws a 4xx BedrockClaudeError. */
export function validateConversation(value: unknown): ConversationBody {
  if (!value || typeof value !== "object") throw new BedrockClaudeError(400, "Invalid request.");
  const x = value as Record<string, unknown>;
  if (
    typeof x["system"] !== "string" ||
    x["system"].length > 180_000 ||
    !Array.isArray(x["messages"]) ||
    x["messages"].length > 160 ||
    JSON.stringify(value).length > 1_500_000
  ) {
    throw new BedrockClaudeError(413, "The request exceeds the assistant context limit.");
  }
  for (const m of x["messages"] as Record<string, unknown>[]) {
    if (!m || !["user", "assistant", "tool"].includes(String(m["role"]))) {
      throw new BedrockClaudeError(400, "Invalid conversation role.");
    }
    if (m["role"] === "tool") {
      if (!Array.isArray(m["results"]) || m["results"].length > 64) {
        throw new BedrockClaudeError(400, "Invalid tool results.");
      }
    } else if (typeof m["text"] !== "string") {
      throw new BedrockClaudeError(400, "Invalid message text.");
    }
  }
  if (x["tools"] !== undefined && (!Array.isArray(x["tools"]) || x["tools"].length > 64)) {
    throw new BedrockClaudeError(400, "Too many tools.");
  }
  return x as ConversationBody;
}

/** Agent messages -> Converse message list (tool results as user turns). */
function converseMessages(messages: readonly AgentMessage[]): unknown[] {
  const out: unknown[] = [];
  for (const m of messages) {
    const content: unknown[] = [];
    if (m.role === "tool") {
      for (const r of m.results) {
        content.push({
          toolResult: {
            toolUseId: r.id,
            content: [{ text: r.output || "(empty result)" }],
            status: r.isError ? "error" : "success",
          },
        });
      }
      out.push({ role: "user", content });
      continue;
    }
    if (m.role === "assistant") {
      for (const r of reasoningBlocks(m.reasoning)) {
        const block = r as Record<string, unknown>;
        content.push({
          reasoningContent: block["redactedContent"]
            ? { redactedContent: block["redactedContent"] }
            : block,
        });
      }
    }
    if (m.text) content.push({ text: m.text });
    if (m.role === "user") {
      for (const image of m.images ?? []) {
        const format = image.mime.replace("image/", "").replace("jpg", "jpeg");
        if (!["jpeg", "png", "gif", "webp"].includes(format) || image.base64.length > 7_000_000) {
          throw new BedrockClaudeError(413, "Unsupported or oversized image attachment.");
        }
        content.push({ image: { format, source: { bytes: image.base64 } } });
      }
    }
    if (m.role === "assistant") {
      for (const t of m.toolCalls ?? []) {
        content.push({ toolUse: { toolUseId: t.id, name: t.name, input: t.input } });
      }
    }
    if (content.length) out.push({ role: m.role, content });
  }
  return out;
}

function parseToolCall(
  id: string,
  name: string,
  input: string,
  allowed: Set<string>,
): AgentToolCall {
  if (!allowed.has(name)) {
    return { id, name, input: {}, inputError: "The requested tool is not permitted in this mode." };
  }
  try {
    const data = JSON.parse(input || "{}");
    if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error();
    return { id, name, input: data as Record<string, unknown> };
  } catch {
    return { id, name, input: {}, inputError: "Tool arguments were not a complete JSON object." };
  }
}

export type WriterUsage = {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
};

export type WriterStreamCallbacks = {
  onDelta(text: string): void;
  onReasoning(text: string): void;
  onToolCall(call: AgentToolCall): void;
  onStopReason(reason: string): void;
  onUsage?(usage: WriterUsage): void;
};

/**
 * Stream one Converse turn. Tool definitions passed here are already filtered
 * to the caller's mode; the parser rejects any call outside that set.
 */
export async function streamWriterTurn(
  req: {
    profile: WriterProfile;
    system: string;
    messages: AgentMessage[];
    tools: AgentToolDef[];
    signal: AbortSignal;
  },
  cb: WriterStreamCallbacks,
): Promise<void> {
  const allowed = new Set(req.tools.map((t) => t.name));
  const messages = converseMessages(req.messages) as Array<{ role: string; content: unknown[] }>;
  if (PROMPT_CACHE && messages.length) {
    // Checkpoint the whole conversation prefix at the newest message: the next
    // round appends the assistant turn and tool results after this point.
    const last = messages[messages.length - 1]!;
    last.content = [...last.content, CACHE_POINT];
  }
  const buildBody = (effort: string): Record<string, unknown> => ({
    system: PROMPT_CACHE ? [{ text: req.system }, CACHE_POINT] : [{ text: req.system }],
    messages,
    inferenceConfig: { maxTokens: MAX_TOKENS[req.profile] },
    ...(req.tools.length
      ? {
          toolConfig: {
            tools: [
              ...req.tools.map((t) => ({
                toolSpec: {
                  name: t.name,
                  description: t.description,
                  inputSchema: { json: t.inputSchema },
                },
              })),
              ...(PROMPT_CACHE ? [CACHE_POINT] : []),
            ],
          },
        }
      : {}),
    ...(effort
      ? {
          additionalModelRequestFields: {
            thinking: { type: "adaptive" },
            output_config: { effort },
          },
        }
      : {}),
  });

  const request = (effort: string) =>
    signedBedrockFetch(converseStreamEndpoint(WRITER_MODEL), {
      headers: { accept: "application/vnd.amazon.eventstream" },
      body: JSON.stringify(buildBody(effort)),
      signal: req.signal,
    });

  let effort = thinkingEffort(req.profile);
  let res = await request(effort);
  if (!res.ok && effort && res.status === 400) {
    // The configured model does not accept adaptive thinking (or this effort
    // value): fall back to a plain request rather than failing the turn.
    const detail = await res.text().catch(() => "");
    console.warn(
      `[office] adaptive thinking rejected by ${WRITER_MODEL}; retrying without it: ${detail.slice(0, 200)}`,
    );
    effort = "";
    res = await request(effort);
  }
  if (!res.ok || !res.body) {
    const detail = await res.text().catch(() => "");
    throw new BedrockClaudeError(
      res.status,
      `Bedrock Converse request failed [${res.status}] (${WRITER_MODEL}): ${detail.slice(0, 400)}`,
    );
  }

  const reader = res.body.getReader();
  let pending: Bytes = new Uint8Array(0);
  // Streaming tool-use arguments and reasoning, keyed by content block index.
  const calls = new Map<number, { id: string; name: string; json: string }>();
  const reasoning = new Map<number, { text: string; signature: string; redacted: string[] }>();
  let complete = false;
  let truncated = false;

  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      if (!value) continue;
      if (req.signal.aborted) throw new DOMException("Stopped", "AbortError");
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
        const index = Number(evt["contentBlockIndex"] ?? -1);

        // contentBlockStart: a tool-use block opens.
        const start = evt["start"] as Record<string, unknown> | undefined;
        if (start && typeof start === "object" && start["toolUse"]) {
          const t = start["toolUse"] as Record<string, unknown>;
          calls.set(index, {
            id: String(t["toolUseId"] ?? ""),
            name: String(t["name"] ?? ""),
            json: "",
          });
          continue;
        }

        // contentBlockDelta: text, tool input, or reasoning.
        const delta = evt["delta"] as Record<string, unknown> | undefined;
        if (delta && typeof delta === "object") {
          const text = delta["text"];
          if (typeof text === "string" && text) cb.onDelta(text);
          const toolUse = delta["toolUse"] as Record<string, unknown> | undefined;
          if (toolUse && typeof toolUse["input"] === "string") {
            const t = calls.get(index);
            if (t) {
              t.json += toolUse["input"];
              if (t.json.length > 1_000_000) {
                throw new BedrockClaudeError(413, "Tool output exceeded the size limit.");
              }
            }
          }
          const rc = delta["reasoningContent"] as Record<string, unknown> | undefined;
          if (rc && typeof rc === "object") {
            const r = reasoning.get(index) ?? { text: "", signature: "", redacted: [] };
            if (typeof rc["text"] === "string") r.text += rc["text"];
            if (typeof rc["signature"] === "string") r.signature += rc["signature"];
            if (typeof rc["redactedContent"] === "string") r.redacted.push(rc["redactedContent"]);
            reasoning.set(index, r);
          }
          continue;
        }

        // messageStop.
        if (typeof evt["stopReason"] === "string") {
          complete = true;
          truncated = evt["stopReason"] === "max_tokens";
          cb.onStopReason(String(evt["stopReason"] || "end_turn"));
          continue;
        }

        // metadata: token accounting (cache hits confirm the checkpoints work).
        const usage = evt["usage"] as Record<string, unknown> | undefined;
        if (usage && typeof usage === "object") {
          cb.onUsage?.({
            inputTokens: Number(usage["inputTokens"] ?? 0),
            outputTokens: Number(usage["outputTokens"] ?? 0),
            cacheReadTokens: Number(usage["cacheReadInputTokens"] ?? 0),
            cacheWriteTokens: Number(usage["cacheWriteInputTokens"] ?? 0),
          });
          continue;
        }

        // Exception frames arrive as a bare { message } payload.
        if (
          evt["role"] === undefined &&
          evt["usage"] === undefined &&
          evt["metrics"] === undefined
        ) {
          const errMsg = evt["message"] ?? evt["Message"];
          if (typeof errMsg === "string" && errMsg) {
            throw new BedrockClaudeError(502, `The writing service reported an error: ${errMsg}`);
          }
        }
      }
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }

  if (!complete) throw new BedrockClaudeError(502, "The response ended before completion.");

  const blocks = [...reasoning.values()].map((r) =>
    r.redacted.length
      ? { redactedContent: r.redacted.join("") }
      : { reasoningText: { text: r.text, signature: r.signature } },
  );
  if (blocks.length) cb.onReasoning(packReasoning(blocks));
  for (const t of calls.values()) {
    cb.onToolCall({
      ...parseToolCall(t.id, t.name, t.json, allowed),
      ...(truncated ? { truncated: true } : {}),
    });
  }
}
