// ============================================================================
// Office assistant inference (server-only). One model turn of an editor's
// browser-side agent loop: the renderer sends {system, messages, tools}; this
// streams the reply from Bedrock Converse and hands back text deltas, readable
// and opaque reasoning, status lines, and complete tool calls. Tool EXECUTION
// stays in the browser (document tools run against the live editor; platform
// tools call back into the platform). The server enforces the per-app/per-mode
// tool allow-list and picks the model tier for the turn.
//
// Model tiering
// -------------
// Every run (one user instruction and the tool rounds it triggers) is classed
// once by a small router model into inspect / format / short_edit / draft /
// analyze. Inspect, format and short edits go to the fast tier (Haiku 4.5 by
// default; an optional text-only inspect model such as Nemotron Super can take
// inspect/format when no images are in play); drafting and analysis go to the
// main tier (Sonnet 5). The Thorough profile always uses the main tier. The
// class is cached per instruction so later rounds of the same run route the
// same way, and the opaque reasoning blob is tagged with the model that made
// it so signed thinking blocks are only ever echoed to that model.
//
// Budgets are generous on purpose: output tokens default to 32k/64k, the
// payload cap tracks the API Gateway request limit, and images are bounded by
// the provider's own per-image limit rather than anything stricter.
// ============================================================================
import {
  BedrockClaudeError,
  concat,
  converseStreamEndpoint,
  decodeFrames,
  type Bytes,
} from "@/lib/agents/bedrock-claude.server";
import {
  BEDROCK_MAX_RETRIES,
  bedrockRetryDelayMs,
  isRetryableBedrockStatus,
  retryAfterMsFrom,
  signedBedrockFetch,
} from "@/lib/agents/bedrock-sign.server";

export type WriterProfile = "standard" | "thorough";
export type WriterMode = "write" | "ask" | "review" | "research";

// --- Models -----------------------------------------------------------------------

const env = (name: string): string => (process.env[name] ?? "").trim();

/** Main tier: drafting, analysis, anything the router is unsure about. */
export const WRITER_MODEL =
  env("OFFICE_MODEL") ||
  env("WRITER_BEDROCK_MODEL") ||
  env("BEDROCK_RESEARCH_MODEL") ||
  "us.anthropic.claude-sonnet-5";

/** Fast tier: inspect, format and short-edit rounds. Vision-capable. */
export const OFFICE_FAST_MODEL =
  env("OFFICE_FAST_MODEL") || "us.anthropic.claude-haiku-4-5-20251001-v1:0";

/**
 * Optional inspect tier for pure read/format runs with no images in the
 * conversation, e.g. `nvidia.nemotron-super-3-120b`. Empty = use the fast tier.
 */
export const OFFICE_INSPECT_MODEL = env("OFFICE_INSPECT_MODEL");

/**
 * Task classes the inspect tier handles. Default `inspect` only: in the
 * 2026-09-11 probe Nemotron Super answered read/inspect rounds fastest and
 * correctly, but on a format request it chose to read first instead of
 * writing the DSL ops, so `format` stays on the fast tier unless
 * OFFICE_INSPECT_CLASSES="inspect,format" widens it.
 */
const INSPECT_CLASSES = new Set<string>(
  (env("OFFICE_INSPECT_CLASSES") || "inspect")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
);

/** Router model that classes each run; tiny prompt, one-word answer. */
export const OFFICE_ROUTER_MODEL = env("OFFICE_ROUTER_MODEL") || OFFICE_FAST_MODEL;

/** `off` disables tiering: every turn goes to the main model. */
const TIERING_ON = env("OFFICE_TIERING").toLowerCase() !== "off";

export type ModelTier = "main" | "fast" | "inspect";
export type TaskClass = "inspect" | "format" | "short_edit" | "draft" | "analyze";

const REGION = process.env["BEDROCK_REGION"] ?? "us-east-1";

function isAnthropic(model: string): boolean {
  return /anthropic|claude/i.test(model);
}

/** Models that accept image content blocks on Converse. */
function supportsVision(model: string): boolean {
  return (
    isAnthropic(model) ||
    /nova-(lite|pro|premier|2-lite)/i.test(model) ||
    /nemotron-nano-12b/i.test(model) ||
    /llama4|llama-4/i.test(model) ||
    /openai\.gpt/i.test(model)
  );
}

// --- Output token budget ----------------------------------------------------------

function envInt(name: string, fallback: number): number {
  const n = Number.parseInt(env(name), 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/**
 * Output budget per profile. Never a quality lever: these are ceilings the
 * model rarely approaches, sized so a long redraft or a multi-slide script is
 * never cut off. A model that rejects the ceiling gets a smaller retry.
 */
const MAX_TOKENS: Record<WriterProfile, number> = {
  standard: envInt("OFFICE_MAX_TOKENS_STANDARD", 32_768),
  thorough: envInt("OFFICE_MAX_TOKENS_THOROUGH", 65_536),
};

/** Known hard output ceilings; unknown models start from the profile budget and back off on 400. */
function modelOutputCap(model: string): number {
  if (/claude-haiku-4-5|claude-sonnet-4|claude-sonnet-5|claude-opus-5|claude-fable/i.test(model)) return 65_536;
  if (/claude-3/i.test(model)) return 8_192;
  if (/nemotron/i.test(model)) return envInt("OFFICE_NEMOTRON_MAX_TOKENS", 32_768);
  return 65_536;
}

function maxTokensFor(model: string, profile: WriterProfile): number {
  return Math.min(MAX_TOKENS[profile], modelOutputCap(model));
}

// --- Thinking ----------------------------------------------------------------------

/**
 * Adaptive-thinking effort per profile and tier. Defaults: fast tier off
 * (latency), main Standard low, main Thorough high. Overrides:
 * OFFICE_THINKING_EFFORT (global), OFFICE_THINKING_EFFORT_STANDARD/THOROUGH,
 * OFFICE_FAST_THINKING_EFFORT; legacy WRITER_THINKING_EFFORT* still honored.
 * `off` disables thinking. Non-Anthropic models never receive thinking fields.
 */
const THINKING_LEVELS = new Set(["low", "medium", "high", "max"]);
function thinkingEffort(profile: WriterProfile, tier: ModelTier, model: string): string {
  if (!isAnthropic(model)) return "";
  const pick = (...names: string[]): string => {
    for (const n of names) {
      const v = env(n).toLowerCase();
      if (v) return v;
    }
    return "";
  };
  const value =
    tier === "main"
      ? pick(
          "OFFICE_THINKING_EFFORT",
          "WRITER_THINKING_EFFORT",
          `OFFICE_THINKING_EFFORT_${profile.toUpperCase()}`,
          `WRITER_THINKING_EFFORT_${profile.toUpperCase()}`,
        ) || (profile === "thorough" ? "high" : "low")
      : pick("OFFICE_FAST_THINKING_EFFORT") || "off";
  return THINKING_LEVELS.has(value) ? value : "";
}

/**
 * Prompt caching (Anthropic models). The system prompt, the tool schemas and
 * the conversation prefix are identical from one tool round to the next, so
 * mark each as a Bedrock cache checkpoint. Disable with OFFICE_PROMPT_CACHE=off
 * (legacy WRITER_PROMPT_CACHE honored).
 */
const PROMPT_CACHE =
  (env("OFFICE_PROMPT_CACHE") || env("WRITER_PROMPT_CACHE") || "on").toLowerCase() !== "off";
const CACHE_POINT = { cachePoint: { type: "default" } };

// --- Tool policy (mirrors each app's src/shared/sw-policy.ts) ----------------------

export type OfficeApp = "writer" | "sheets" | "slides";

export function isOfficeApp(v: unknown): v is OfficeApp {
  return v === "writer" || v === "sheets" || v === "slides";
}

// Platform-executed tools (src/office/shared/platform-skill.ts): none of them
// changes the open document, so every mode may call them. Image producers
// return a handle; placing the image is the editor's own (write) tool.
const PLATFORM_READ = [
  "run_python",
  "verify_citations",
  "fetch_page",
  "load_firm_guide",
  "ask_clarification",
  "render_diagram",
  "generate_image",
  "edit_image",
  "search_firm_knowledge",
  "search_library",
  "web_search",
  "image_search",
];

const WRITER_READ = [
  ...PLATFORM_READ.filter((n) => n !== "generate_image"),
  "get_document_context",
  "read_blocks",
  "read_revisions",
  "read_comments",
  "read_attachment",
  "view_page",
  "list_templates",
];
const WRITER_WRITE = [
  ...WRITER_READ,
  // Writer's own generate_image places the picture, so it is an edit there.
  "generate_image",
  "insert_content",
  "replace_blocks",
  "apply_commands",
  "insert_chart",
  "edit_chart",
  "insert_image",
  "insert_table",
  "edit_table",
  "set_header_footer",
  "reply_comment",
  "resolve_comment",
  "create_document",
  "apply_template",
  "save_template",
];

const SHEETS_READ = [
  ...PLATFORM_READ,
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
  "view_range",
  "list_templates",
];
const SHEETS_WRITE = [
  ...SHEETS_READ,
  "propose_operations",
  "insert_image",
  "create_document",
  "apply_template",
  "save_template",
];

const SLIDES_READ = [
  ...PLATFORM_READ,
  "read_slide",
  "load_guide",
  "read_attachment",
  "list_slide_templates",
  "audit_layout",
  "list_style_templates",
  "view_slide",
  "list_templates",
];
const SLIDES_WRITE = [
  ...SLIDES_READ,
  "execute_slide_script",
  "add_slide",
  "edit_table_style",
  "edit_chart",
  "apply_ops",
  "design_slide_html",
  "save_style_template",
  "create_presentation",
  "insert_web_image",
  "replace_image",
  "create_document",
  "apply_template",
  "save_template",
];

/** Research mode: sources only, no document reads or edits. */
const RESEARCH_TOOLS = [
  "web_search",
  "fetch_page",
  "search_firm_knowledge",
  "search_library",
  "verify_citations",
  "run_python",
  "ask_clarification",
];

const POLICY: Record<OfficeApp, { read: string[]; write: string[] }> = {
  writer: { read: WRITER_READ, write: WRITER_WRITE },
  sheets: { read: SHEETS_READ, write: SHEETS_WRITE },
  slides: { read: SLIDES_READ, write: SLIDES_WRITE },
};

export function allowedToolNames(mode: WriterMode, app: OfficeApp = "writer"): Set<string> {
  if (mode === "research") return new Set(RESEARCH_TOOLS);
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
export type AgentToolResult = {
  id: string;
  name: string;
  output: string;
  isError?: boolean;
  images?: AgentImage[];
};
export type AgentMessage =
  | { role: "user"; text: string; images?: AgentImage[] }
  | { role: "assistant"; text: string; toolCalls?: AgentToolCall[]; reasoning?: string }
  | { role: "tool"; results: AgentToolResult[] };

/** Shared contract with @genoffice/agent-core (OPAQUE_REASONING_PREFIX). */
const REASONING_PREFIX = "sw-opaque-reasoning:";

/**
 * Pack Converse reasoning blocks into the opaque string the renderer echoes
 * back, tagged with the producing model: signed thinking blocks are only valid
 * for that model, so a round served by another tier drops them.
 */
export function packReasoning(blocks: unknown[], model: string): string {
  return `${REASONING_PREFIX}${JSON.stringify({ model, blocks })}`;
}

function reasoningBlocks(value: unknown, model: string): unknown[] {
  if (typeof value !== "string") return [];
  const at = value.indexOf(REASONING_PREFIX);
  if (at < 0) return [];
  try {
    const parsed = JSON.parse(value.slice(at + REASONING_PREFIX.length)) as unknown;
    if (Array.isArray(parsed)) return []; // legacy untagged blob: producer unknown, do not echo
    const obj = parsed as { model?: string; blocks?: unknown[] };
    if (obj.model !== model || !Array.isArray(obj.blocks)) return [];
    return obj.blocks;
  } catch {
    return [];
  }
}

export type ConversationBody = {
  system: string;
  messages: AgentMessage[];
  tools?: AgentToolDef[];
};

/**
 * Request payload ceiling. API Gateway rejects bodies over 10 MB, so this is
 * the wire limit, not a context policy; images are bounded per item below.
 */
const MAX_PAYLOAD_CHARS = 9_500_000;
const MAX_SYSTEM_CHARS = 600_000;
const MAX_MESSAGES = 600;
const MAX_TOOL_RESULTS = 64;
const MAX_TOOLS = 96;
/** Bedrock's per-image ceiling is 3.75 MB of bytes (~5 MB base64). */
const MAX_IMAGE_BASE64 = 5_000_000;
/** Images per message (Bedrock allows 20 per request; Converse counts tool-result images too). */
const MAX_IMAGES_PER_MESSAGE = 20;
const IMAGE_FORMATS = new Set(["jpeg", "png", "gif", "webp"]);

/** Bound and shape-check the renderer's conversation payload; throws a 4xx BedrockClaudeError. */
export function validateConversation(value: unknown): ConversationBody {
  if (!value || typeof value !== "object") throw new BedrockClaudeError(400, "Invalid request.");
  const x = value as Record<string, unknown>;
  if (
    typeof x["system"] !== "string" ||
    x["system"].length > MAX_SYSTEM_CHARS ||
    !Array.isArray(x["messages"]) ||
    x["messages"].length > MAX_MESSAGES ||
    JSON.stringify(value).length > MAX_PAYLOAD_CHARS
  ) {
    throw new BedrockClaudeError(413, "The request exceeds the assistant context limit.");
  }
  for (const m of x["messages"] as Record<string, unknown>[]) {
    if (!m || !["user", "assistant", "tool"].includes(String(m["role"]))) {
      throw new BedrockClaudeError(400, "Invalid conversation role.");
    }
    if (m["role"] === "tool") {
      if (!Array.isArray(m["results"]) || m["results"].length > MAX_TOOL_RESULTS) {
        throw new BedrockClaudeError(400, "Invalid tool results.");
      }
      for (const r of m["results"] as Record<string, unknown>[]) {
        if (!r || typeof r["id"] !== "string" || typeof r["output"] !== "string") {
          throw new BedrockClaudeError(400, "Invalid tool result.");
        }
        if (r["images"] !== undefined) validateImages(r["images"]);
      }
    } else if (typeof m["text"] !== "string") {
      throw new BedrockClaudeError(400, "Invalid message text.");
    } else if (m["role"] === "user" && m["images"] !== undefined) {
      validateImages(m["images"]);
    }
  }
  if (x["tools"] !== undefined && (!Array.isArray(x["tools"]) || x["tools"].length > MAX_TOOLS)) {
    throw new BedrockClaudeError(400, "Too many tools.");
  }
  return x as ConversationBody;
}

function imageFormat(mime: string): string {
  return mime.replace("image/", "").replace("jpg", "jpeg").toLowerCase();
}

function validateImages(value: unknown): void {
  if (!Array.isArray(value) || value.length > MAX_IMAGES_PER_MESSAGE) {
    throw new BedrockClaudeError(413, "Too many images in one message.");
  }
  for (const img of value as Record<string, unknown>[]) {
    if (
      !img ||
      typeof img["base64"] !== "string" ||
      typeof img["mime"] !== "string" ||
      !IMAGE_FORMATS.has(imageFormat(img["mime"])) ||
      img["base64"].length > MAX_IMAGE_BASE64
    ) {
      throw new BedrockClaudeError(413, "Unsupported or oversized image attachment.");
    }
  }
}

function imageBlock(image: AgentImage): unknown {
  return { image: { format: imageFormat(image.mime), source: { bytes: image.base64 } } };
}

export function conversationHasImages(messages: readonly AgentMessage[]): boolean {
  return messages.some((m) =>
    m.role === "user"
      ? !!m.images?.length
      : m.role === "tool"
        ? m.results.some((r) => !!r.images?.length)
        : false,
  );
}

/** Agent messages -> Converse message list (tool results as user turns). */
function converseMessages(messages: readonly AgentMessage[], model: string): unknown[] {
  const vision = supportsVision(model);
  const out: unknown[] = [];
  for (const m of messages) {
    const content: unknown[] = [];
    if (m.role === "tool") {
      for (const r of m.results) {
        const blocks: unknown[] = [{ text: r.output || "(empty result)" }];
        if (vision) for (const img of r.images ?? []) blocks.push(imageBlock(img));
        content.push({
          toolResult: {
            toolUseId: r.id,
            content: blocks,
            status: r.isError ? "error" : "success",
          },
        });
      }
      out.push({ role: "user", content });
      continue;
    }
    if (m.role === "assistant") {
      for (const r of reasoningBlocks(m.reasoning, model)) {
        const block = r as Record<string, unknown>;
        content.push({
          reasoningContent: block["redactedContent"]
            ? { redactedContent: block["redactedContent"] }
            : block,
        });
      }
    }
    if (m.text) content.push({ text: m.text });
    if (m.role === "user" && vision) {
      for (const image of m.images ?? []) content.push(imageBlock(image));
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

// --- Task routing -------------------------------------------------------------------

const ROUTER_SYSTEM = `You class requests to a document assistant (Word-like writer, spreadsheet, or slide deck editor). Answer with exactly one word from this list and nothing else:
inspect - read, find, explain, summarize what is in the document, answer a question, check or audit without changing content (includes citation checks, counting, comparing, listing).
format - change appearance or layout only: fonts, spacing, alignment, styles, headings levels, numbering, column widths, colors, slide layout tidy-ups, consistency fixes, table styling, cleanup.
short_edit - small, well-specified content edits: fix a typo or sentence, rename, change a number or date, add or remove one item, a one-paragraph tweak, fill one cell or formula, swap one image, delete a slide.
draft - write or generate new substantive content: sections, memos, letters, summaries, several slides, a deck, a table with new data, a chart from analysis, restructure a document, rewrite for tone across a document.
analyze - work needing careful judgment or multi-step reasoning: legal analysis, argument review, reconciling sources, complex data analysis or modelling, research across sources, risk assessment.
If the request mixes classes, pick the heaviest: analyze > draft > short_edit > format > inspect.`;

const ROUTE_CACHE_MAX = 2_000;
const routeCache = new Map<string, TaskClass>();

function hashKey(app: OfficeApp, text: string): string {
  // FNV-1a over the first 4k chars: cheap, collision risk irrelevant for a routing hint.
  let h = 0x811c9dc5;
  const s = `${app}\u0000${text.slice(0, 4_000)}`;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return `${app}:${h.toString(16)}:${s.length}`;
}

function cacheRoute(key: string, cls: TaskClass): void {
  routeCache.set(key, cls);
  if (routeCache.size > ROUTE_CACHE_MAX) {
    const first = routeCache.keys().next().value;
    if (first !== undefined) routeCache.delete(first);
  }
}

/** The instruction driving this run: the newest user message (never a tool result). */
export function currentInstruction(messages: readonly AgentMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.role === "user") return m.text;
  }
  return "";
}

const TASK_CLASSES = new Set<TaskClass>(["inspect", "format", "short_edit", "draft", "analyze"]);

/** Cheap lexical pre-filter so obvious cases skip the router round-trip. */
function heuristicClass(instruction: string): TaskClass | null {
  const head = instruction.split("\n")[0]?.trim().toLowerCase() ?? "";
  if (!head) return null;
  if (head.length > 600) return null;
  if (/^(what|which|where|who|how many|how much|is there|are there|does|do|did|can you tell|tell me|explain|summari[sz]e|list|find|show me|check|verify|count|compare)\b/.test(head) && head.length < 200)
    return "inspect";
  if (/^(fix|correct) (the |a |this )?(typo|spelling|grammar)/.test(head)) return "short_edit";
  if (/^(bold|italici[sz]e|underline|center|align|indent|change (the )?font|set (the )?font|make (it|this|the (title|heading)s?) (bold|bigger|smaller|larger|red|blue|centered))/.test(head))
    return "format";
  if (/\b(memo|brief|motion|letter|deck|presentation|report|draft|write|compose|generate|create|build|prepare)\b/.test(head) && /\b(memo|brief|motion|letter|deck|presentation|report|slides|sections?|pages?|chapters?|outline)\b/.test(head))
    return "draft";
  return null;
}

/**
 * Class the run's instruction. Router failures and timeouts return null, and
 * the caller falls back to the main tier (never a weaker one).
 */
export async function classifyTask(
  app: OfficeApp,
  instruction: string,
  signal?: AbortSignal,
): Promise<TaskClass | null> {
  const text = instruction.trim();
  if (!text) return null;
  const key = hashKey(app, text);
  const cached = routeCache.get(key);
  if (cached) return cached;
  const quick = heuristicClass(text);
  if (quick) {
    cacheRoute(key, quick);
    return quick;
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 4_000);
  const onAbort = () => controller.abort();
  signal?.addEventListener("abort", onAbort);
  try {
    const res = await signedBedrockFetch(
      `https://bedrock-runtime.${REGION}.amazonaws.com/model/${encodeURIComponent(OFFICE_ROUTER_MODEL)}/converse`,
      {
        body: JSON.stringify({
          system: [{ text: ROUTER_SYSTEM }],
          messages: [{ role: "user", content: [{ text: `Editor: ${app}\nRequest:\n${text.slice(0, 3_000)}` }] }],
          inferenceConfig: { maxTokens: 8, temperature: 0 },
        }),
        signal: controller.signal,
      },
    );
    if (!res.ok) return null;
    const data = (await res.json()) as {
      output?: { message?: { content?: Array<{ text?: string }> } };
    };
    const word = (data.output?.message?.content?.[0]?.text ?? "")
      .trim()
      .toLowerCase()
      .replace(/[^a-z_]/g, "");
    if (!TASK_CLASSES.has(word as TaskClass)) return null;
    cacheRoute(key, word as TaskClass);
    return word as TaskClass;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
}

export type RouteDecision = { model: string; tier: ModelTier; taskClass: TaskClass | null };

/** Pick the model for this turn from profile, task class and image presence. */
export async function routeTurn(req: {
  app: OfficeApp;
  profile: WriterProfile;
  messages: readonly AgentMessage[];
  signal?: AbortSignal;
}): Promise<RouteDecision> {
  if (!TIERING_ON || req.profile === "thorough") {
    return { model: WRITER_MODEL, tier: "main", taskClass: null };
  }
  const taskClass = await classifyTask(req.app, currentInstruction(req.messages), req.signal);
  if (!taskClass || taskClass === "draft" || taskClass === "analyze") {
    return { model: WRITER_MODEL, tier: "main", taskClass };
  }
  const hasImages = conversationHasImages(req.messages);
  if (OFFICE_INSPECT_MODEL && INSPECT_CLASSES.has(taskClass)) {
    if (!hasImages || supportsVision(OFFICE_INSPECT_MODEL)) {
      return { model: OFFICE_INSPECT_MODEL, tier: "inspect", taskClass };
    }
  }
  if (hasImages && !supportsVision(OFFICE_FAST_MODEL)) {
    return { model: WRITER_MODEL, tier: "main", taskClass };
  }
  return { model: OFFICE_FAST_MODEL, tier: "fast", taskClass };
}

// --- One streamed turn ---------------------------------------------------------------

export type WriterUsage = {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
};

export type WriterStreamCallbacks = {
  onDelta(text: string): void;
  /** readable reasoning deltas and, at the end of the turn, one opaque signed blob */
  onReasoning(text: string): void;
  onToolCall(call: AgentToolCall): void;
  onStopReason(reason: string): void;
  onStatus?(status: { text: string; model: string; tier: ModelTier; taskClass: TaskClass | null }): void;
  onUsage?(usage: WriterUsage & { model: string; tier: ModelTier; ttfbMs: number }): void;
};

const TIER_LABEL: Record<ModelTier, string> = {
  main: "Working with the main model",
  fast: "Working with the fast model",
  inspect: "Working with the inspect model",
};

/**
 * Stream one Converse turn. Tool definitions passed here are already filtered
 * to the caller's mode; the parser rejects any call outside that set.
 */
export async function streamWriterTurn(
  req: {
    app?: OfficeApp;
    profile: WriterProfile;
    system: string;
    messages: AgentMessage[];
    tools: AgentToolDef[];
    signal: AbortSignal;
    /** Skip routing and use this model (tests, admin probes). */
    model?: string;
  },
  cb: WriterStreamCallbacks,
): Promise<void> {
  const app = req.app ?? "writer";
  const route: RouteDecision = req.model
    ? { model: req.model, tier: "main", taskClass: null }
    : await routeTurn({ app, profile: req.profile, messages: req.messages, signal: req.signal });
  const model = route.model;
  const anthropic = isAnthropic(model);
  const cache = PROMPT_CACHE && anthropic;
  cb.onStatus?.({ text: TIER_LABEL[route.tier], model, tier: route.tier, taskClass: route.taskClass });

  const allowed = new Set(req.tools.map((t) => t.name));
  const messages = converseMessages(req.messages, model) as Array<{ role: string; content: unknown[] }>;
  if (cache && messages.length) {
    // Checkpoint the whole conversation prefix at the newest message: the next
    // round appends the assistant turn and tool results after this point.
    const last = messages[messages.length - 1]!;
    last.content = [...last.content, CACHE_POINT];
  }
  const buildBody = (effort: string, maxTokens: number): Record<string, unknown> => ({
    system: cache ? [{ text: req.system }, CACHE_POINT] : [{ text: req.system }],
    messages,
    inferenceConfig: { maxTokens },
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
              ...(cache ? [CACHE_POINT] : []),
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

  const startedAt = Date.now();
  const request = async (effort: string, maxTokens: number): Promise<Response> => {
    // Throttling and transient 5xx before the stream opens are retried with
    // jittered backoff; once bytes flow the turn is committed.
    let attempt = 0;
    for (;;) {
      const res = await signedBedrockFetch(converseStreamEndpoint(model), {
        headers: { accept: "application/vnd.amazon.eventstream" },
        body: JSON.stringify(buildBody(effort, maxTokens)),
        signal: req.signal,
      });
      if (res.ok || !isRetryableBedrockStatus(res.status) || attempt >= BEDROCK_MAX_RETRIES) return res;
      const delay = bedrockRetryDelayMs(attempt, retryAfterMsFrom(res));
      await res.text().catch(() => "");
      await new Promise<void>((resolve, reject) => {
        const t = setTimeout(resolve, delay);
        req.signal.addEventListener(
          "abort",
          () => {
            clearTimeout(t);
            reject(new DOMException("Stopped", "AbortError"));
          },
          { once: true },
        );
      });
      attempt++;
    }
  };

  let effort = thinkingEffort(req.profile, route.tier, model);
  let maxTokens = maxTokensFor(model, req.profile);
  let res = await request(effort, maxTokens);
  for (let fixes = 0; !res.ok && res.status === 400 && fixes < 3; fixes++) {
    const detail = await res.text().catch(() => "");
    if (/max_tokens|maxTokens|max tokens|output tokens/i.test(detail) && maxTokens > 8_192) {
      // The model's output ceiling is lower than the profile budget: back off.
      maxTokens = Math.max(8_192, Math.floor(maxTokens / 2));
      console.warn(`[office] ${model} rejected maxTokens; retrying with ${maxTokens}: ${detail.slice(0, 160)}`);
    } else if (effort) {
      // The model does not accept adaptive thinking (or this effort value).
      console.warn(`[office] adaptive thinking rejected by ${model}; retrying without it: ${detail.slice(0, 160)}`);
      effort = "";
    } else {
      throw new BedrockClaudeError(400, `Bedrock Converse request failed [400] (${model}): ${detail.slice(0, 400)}`);
    }
    res = await request(effort, maxTokens);
  }
  if (!res.ok || !res.body) {
    const detail = await res.text().catch(() => "");
    throw new BedrockClaudeError(
      res.status,
      `Bedrock Converse request failed [${res.status}] (${model}): ${detail.slice(0, 400)}`,
    );
  }
  const ttfbMs = Date.now() - startedAt;

  const reader = res.body.getReader();
  let pending: Bytes = new Uint8Array(0);
  // Streaming tool-use arguments and reasoning, keyed by content block index.
  const calls = new Map<number, { id: string; name: string; json: string }>();
  const reasoning = new Map<number, { text: string; signature: string; redacted: string[] }>();
  let complete = false;
  let truncated = false;
  const MAX_TOOL_INPUT_CHARS = 4_000_000;

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
              if (t.json.length > MAX_TOOL_INPUT_CHARS) {
                throw new BedrockClaudeError(413, "Tool output exceeded the size limit.");
              }
            }
          }
          const rc = delta["reasoningContent"] as Record<string, unknown> | undefined;
          if (rc && typeof rc === "object") {
            const r = reasoning.get(index) ?? { text: "", signature: "", redacted: [] };
            if (typeof rc["text"] === "string") {
              r.text += rc["text"];
              // Readable thinking streams to the panel as it happens.
              if (rc["text"]) cb.onReasoning(rc["text"]);
            }
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
            model,
            tier: route.tier,
            ttfbMs,
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
  if (blocks.length) cb.onReasoning(packReasoning(blocks, model));
  for (const t of calls.values()) {
    cb.onToolCall({
      ...parseToolCall(t.id, t.name, t.json, allowed),
      ...(truncated ? { truncated: true } : {}),
    });
  }
}
