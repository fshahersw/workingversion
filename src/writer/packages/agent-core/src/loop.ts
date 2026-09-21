import { mapConcurrent } from "./parallel";
import type { AgentSkill, ExecutedToolCall } from "./skill";
import type {
  AgentImage,
  AgentMessage,
  AgentStatus,
  AgentStreamHandle,
  AgentToolCall,
  AgentToolResult,
  AgentTransport,
  ToolExecution,
} from "./types";

export interface ToolExecutedEvent<TSnapshot> {
  call: AgentToolCall;
  execution: ToolExecution;
  /**
   * Snapshot captured just before this tool ran; present only on the first
   * mutating tool of a run (hook for one-click rollback UIs).
   */
  snapshotBefore?: TSnapshot | undefined;
}

export interface AgentRunResult {
  /** final assistant text of the run ('' when cut off) */
  text: string;
  cancelled: boolean;
  /** true when maxTurns was reached; text is the partial answer from the no-tools finalizing turn */
  turnLimit: boolean;
  /** the final turn hit the token limit (stop_reason max_tokens): text is incomplete; set only when true */
  truncated?: boolean;
  /** Claimed work still lacked tool evidence after the bounded repair turn. */
  unverified?: boolean;
}

export interface AgentLoopEvents<TSnapshot> {
  /** cumulative assistant text of the current turn (call per delta) */
  onText?(text: string): void;
  /** a tool is about to execute (UI shows a live "running" indicator; onToolExecuted always follows) */
  onToolStart?(call: AgentToolCall): void;
  onToolExecuted?(event: ToolExecutedEvent<TSnapshot>): void;
  /** a turn requested tools and they ran; the loop is going back to the model */
  onTurnEnd?(directions?: readonly string[]): void;
  onDone?(result: AgentRunResult): void;
  onError?(error: string): void;
  /** cumulative model reasoning of the current turn (call per delta); UIs render it as a collapsible "thinking" strip */
  onReasoning?(text: string): void;
  /** server status line for the current turn (model tier chosen, planning, ...) */
  onStatus?(status: AgentStatus): void;
}

/** Context compaction config (budget tracked in UTF-8 bytes rather than message count) */
export interface CompactionOptions {
  /** History size that triggers compaction (UTF-8 bytes, default 256 KiB). A byte heuristic, not a token limit. */
  maxBytes?: number;
  /** Size of recent messages kept after compaction (bytes, default 96 KiB) */
  keepRecentBytes?: number;
  /** Disable LLM summarization and use only the mechanical digest (for tests/offline) */
  disableLlmSummary?: boolean;
}

export interface AgentLoopOptions<TSnapshot = unknown> {
  transport: AgentTransport;
  skill: AgentSkill;
  events?: AgentLoopEvents<TSnapshot>;
  /** hard cap on model round-trips per run (default DEFAULT_MAX_TURNS) */
  maxTurns?: number;
  /** history cap in messages, trimmed at user-turn boundaries (default 500) */
  maxHistory?: number;
  /** At most two in-place retries of transient model-stream failures; tools are never replayed. */
  transientRetryDelaysMs?: readonly number[];
  /** Context compaction; false disables it (enabled by default with default thresholds) */
  compaction?: CompactionOptions | false;
  /** capture rollback state; invoked right before tools run (see snapshotBefore) */
  captureSnapshot?(): TSnapshot;
  /** wrap instruction + skill context into the user message text */
  formatUserMessage?(instruction: string, context: string): string;
  /** appended to the system prompt each turn (e.g. reply-language directive following the UI language) */
  systemSuffix?(): string;
}

/**
 * Conservative history byte heuristics leave room for system instructions,
 * schemas and the next response. Bytes do not predict tokens uniformly (in
 * particular for financial tables and JSON), so these are not provider context
 * guarantees. The current indivisible exchange and original user request are
 * preserved even when they exceed this soft budget; providers still enforce
 * their own limits.
 */
const COMPACT_MAX_BYTES = 256 * 1024;
const COMPACT_KEEP_RECENT_BYTES = 96 * 1024;
/** Pre-truncation of each tool output in the summary request (the compaction request itself must not blow up on huge outputs) */
const SUMMARIZE_TOOL_OUTPUT_MAX = 8_000;
const SUMMARIZE_TIMEOUT_MS = 45_000;
/** When over budget mid-run, keep the last N tool messages verbatim and truncate earlier outputs to this length */
const STALE_TOOL_KEEP_RECENT = 4;
const STALE_TOOL_OUTPUT_MAX = 8_000;
/** Default history cap in messages (trimmed at user-turn boundaries) */
const DEFAULT_MAX_HISTORY = 500;

/** Unified turn budget across the suite's chat panels (apps may still override per loop) */
export const DEFAULT_MAX_TURNS = 100;

/**
 * Prefix of reasoning deltas that carry an opaque, provider-signed blob rather
 * than readable text (the platform packs Bedrock thinking blocks this way so
 * they can be echoed back verbatim). Shared contract with the platform's
 * inference layer; UIs never display these.
 */
export const OPAQUE_REASONING_PREFIX = "sw-opaque-reasoning:";

/** Cap on consecutive tool-input parse failures (a successful parse resets it); abort beyond it (keeps the model from burning turns on bad JSON) */
const MAX_INPUT_PARSE_RETRIES = 3;

/**
 * Degenerate-loop guards. Weak models (BYOK/local endpoints especially) can
 * repeat the exact same turn forever or keep issuing failing tool calls; with
 * a large turn budget these must abort early instead of burning it.
 */
const MAX_IDENTICAL_TURNS = 3;
const MAX_ALL_ERROR_TURNS = 8;

/**
 * Backoff schedule for in-place same-turn retries on empty-stream errors.
 * The "(empty stream)" suffix is a cross-layer contract with the ai-provider
 * protocols: the gateway closed the SSE stream without content, tool calls, or
 * message framing — a transient soft-failure. The turn produced nothing and
 * history is untouched, so re-sending the identical request is idempotent;
 * retrying here keeps one gateway hiccup from killing a long multi-tool run.
 */
const EMPTY_STREAM_RETRY_DELAYS_MS = [1_000, 3_000];

const TURN_LIMIT_NOTE =
  "[System] The tool-call turn limit for this request has been reached; no more tools may be called this turn. " +
  "Answer directly from the information already gathered; if the task is unfinished, briefly state what is done and what remains.";

/**
 * Terminal assistant text when tools mutated the artifact (or an edits-only
 * turn was restored) and the model returned no prose. Must be non-empty so
 * provider message converters never emit empty assistant content, which breaks
 * multi-turn follow-ups (see finishTurn / restore).
 * Exported so apps can substitute a localized / tool-derived summary in the UI.
 */
export const COMPLETED_VIA_TOOLS_TEXT = "(completed tool actions; no text reply)";

/**
 * Models default to their training-cutoff year without this (e.g. web searches
 * for "... 2024"). Leads the system prompt and spells out the year: measured
 * against claude-opus-4-7 with the docs prompt, the date alone (front or tail)
 * still produced cutoff-year searches in 6/6 runs; naming the year fixed all.
 */
export function runtimePreamble(now = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  const date = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  return `Today's date is ${date}; the current year is ${now.getFullYear()}.\n\n`;
}

const SUMMARIZE_SYSTEM =
  "You are a conversation compressor. Compress this editing session between the user and the AI assistant into a concise summary so later turns can continue with context. " +
  "Keep: the user's goals and key instructions, completed changes (which files/pages/elements were modified), important facts and data, and outstanding items. " +
  'For specific figures/statistics, mark their provenance: figures from the user or from tool results (e.g. web_search) keep their source; figures the assistant produced without a source must be marked "(unverified)" so later turns do not treat them as established facts. ' +
  "Omit: pleasantries, tool-call details, and intermediate trial and error. Use a bullet list of at most 400 words. Write the summary in the same language as the conversation. Output only the summary body, with no preamble.";

/** Prefix of the synthetic user message that carries the compacted-history summary */
const COMPACT_SUMMARY_PREFIX = "[Summary of earlier conversation";
const COMPACT_SUMMARY_HEADER = "[Summary of earlier conversation (auto-compacted)]";
const COMPACT_SUMMARY_ACK = "Understood, continuing from the progress so far.";

/** Approximate UTF-8 byte count (ASCII 1 byte, CJK etc. 3; surrogate pairs count as 6 — slight overestimate is harmless) */
function utf8Size(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    n += c < 0x80 ? 1 : c < 0x800 ? 2 : 3;
  }
  return n;
}

/** Approximate byte cost of one message (text + tool inputs/outputs + image base64) */
function messageSize(m: AgentMessage): number {
  if (m.role === "tool") {
    return m.results.reduce(
      (n, r) =>
        n + utf8Size(r.output) + 40 + (r.images?.reduce((s, img) => s + img.base64.length, 0) ?? 0),
      0,
    );
  }
  let n = utf8Size(m.text);
  if (m.role === "user" && m.images) {
    n += m.images.reduce((s, img) => s + img.base64.length, 0);
  }
  if (m.role === "assistant" && m.toolCalls) {
    for (const c of m.toolCalls) {
      try {
        n += utf8Size(JSON.stringify(c.input)) + 40;
      } catch {
        n += 40;
      }
    }
  }
  if (m.role === "assistant" && m.reasoning) n += utf8Size(m.reasoning);
  return n;
}

function historySize(messages: readonly AgentMessage[]): number {
  return messages.reduce((n, m) => n + messageSize(m), 0);
}

/** Mechanical digest when LLM summarization is unavailable: bullet list of user instructions + final replies */
function mechanicalDigest(dropped: readonly AgentMessage[], maxChars = 12_000): string {
  const lines: string[] = [];
  for (const m of dropped) {
    if (m.role === "user") {
      // Retain earlier summaries across successive compactions instead of
      // silently erasing the first phase of a long research/editing task.
      lines.push(m.text.startsWith(COMPACT_SUMMARY_PREFIX)
        ? m.text.slice(m.text.indexOf("\n") + 1)
        : `- User instruction: ${m.text.slice(0, 4_000)}`);
    } else if (m.role === "tool") {
      for (const result of m.results) {
        lines.push(`- Tool ${result.name} (${result.isError ? "failed" : "returned"}; historical receipt): ${result.output.slice(0, 2_000)}`);
      }
    } else if (m.role === "assistant" && m.text && !m.toolCalls?.length) {
      if (m.text !== COMPACT_SUMMARY_ACK) lines.push(`  Assistant (not independent evidence): ${m.text.slice(0, 1_000)}`);
    }
  }
  const digest = lines.join("\n") || "(earlier conversation omitted)";
  if (digest.length <= maxChars) return digest;
  const half = Math.max(0, Math.floor((maxChars - 100) / 2));
  return `${digest.slice(0, half)}\n[…middle receipts omitted; read current state or source again before relying on missing details…]\n${digest.slice(-half)}`;
}

/**
 * Generic ReAct loop: user message -> model turn (text + tool calls) ->
 * execute tools -> feed results back -> repeat until the model answers with
 * plain text. History persists across runs, so follow-up questions work.
 */
export class AgentLoop<TSnapshot = unknown> {
  private readonly options: AgentLoopOptions<TSnapshot>;
  private history: AgentMessage[] = [];
  private directions: readonly string[] = [];
  private appliedDirections: string[] = [];
  private directionListeners = new Set<() => void>();
  readonly subscribeDirections = (listener: () => void): (() => void) => {
    this.directionListeners.add(listener);
    return () => {
      this.directionListeners.delete(listener);
    };
  };
  readonly getDirections = (): readonly string[] => this.directions;
  private setDirections(value: readonly string[]): void {
    this.directions = value;
    this.directionListeners.forEach((listener) => listener());
  }
  /** Steer only at a model/tool boundary. Never interrupt or replay an in-flight edit. */
  steer(instruction: string): { accepted: boolean; reason?: string } {
    const text = instruction.trim();
    if (!this.running || this.cancelled || this.finalizing)
      return {
        accepted: false,
        reason: "This task is finishing. Send a new request when it stops.",
      };
    if (!text || text.length > 2000)
      return { accepted: false, reason: "Use between 1 and 2,000 characters." };
    if (this.directions.length >= 4)
      return {
        accepted: false,
        reason: "Four directions are already queued. Wait for them to apply.",
      };
    this.setDirections([...this.directions, sanitizeAgentPayload(text)]);
    return { accepted: true };
  }
  clearDirections(): void {
    this.setDirections([]);
  }
  private applyDirections(): readonly string[] {
    const directions = this.directions;
    if (!directions.length) return directions;
    this.appliedDirections.push(...directions);
    this.history.push({
      role: "user",
      text:
        "Updated directions from the user (apply these to the current task; inspect current state before editing):\n" +
        directions.join("\n\n"),
    });
    this.setDirections([]);
    // New directions are progress, but do not reset the run's total turn budget.
    this.allErrorTurns = 0;
    this.identicalTurns = 0;
    this.lastTurnSig = "";
    return directions;
  }
  /** A bounded status snapshot, never chain-of-thought or hidden reasoning. */
  taskStatus(): {
    busy: boolean;
    stopping: boolean;
    turn: number;
    pending: number;
    response: string;
    state: string;
    error?: string;
  } {
    const reply = [...this.history].reverse().find((m) => m.role === "assistant" && m.text);
    return {
      state: this.running ? (this.cancelled ? "stopping" : "running") : this.outcome,
      ...(this.lastFailure ? { error: this.lastFailure } : {}),
      busy: this.running,
      stopping: this.cancelled && this.running,
      turn: this.turns + 1,
      pending: this.directions.length,
      response: (this.turnText || (reply?.role === "assistant" ? reply.text : "")).slice(-12000),
    };
  }

  private handle: AgentStreamHandle | null = null;
  private running = false;
  private outcome: "idle" | "running" | "completed" | "partial" | "stopped" | "failed" = "idle";
  private lastFailure = "";
  private lastCheckpoint: string | null = null;
  /** Persist with the original user request after an error; never a claim that edits survived rollback. */
  get failureCheckpoint(): string | null { return this.lastCheckpoint; }
  private cancelled = false;
  private turns = 0;
  /** Finalizing turn after hitting the turn limit: no tools, let the model answer from what it has read */
  private finalizing = false;
  private mutationSeen = false;
  private inputParseFails = 0;
  /** signature (text + tool calls) of the previous turn, for the identical-turn guard */
  private lastTurnSig = "";
  private identicalTurns = 0;
  private allErrorTurns = 0;
  private turnStopReason: string | null = null;
  private turnText = "";
  /** opaque provider-signed reasoning of the current turn, echoed back verbatim */
  private turnReasoningOpaque = "";
  /** human-readable reasoning of the current turn (shown in UIs; echoed only when no opaque blob exists) */
  private turnReasoningText = "";
  private toolCalls: AgentToolCall[] = [];
  /** tools actually executed during this run, fed to skill.verifyResponse */
  private executedCalls: ExecutedToolCall[] = [];
  /** verifyResponse may force one extra corrective turn per run — never more */
  private verifyRetryUsed = false;
  /** Original request is pinned during compaction and retained for explicit failure recovery. */
  private runUserMsg: AgentMessage | null = null;
  /** invalidates stale transport callbacks after cancel/reset */
  private generation = 0;
  /** Changes whenever the document conversation is reset. Voice must drop old scope. */
  get conversationVersion(): number {
    return this.generation;
  }
  /** per-run abort: aborted on cancel(); long tools (e.g. generate_deck) use it to break internal loops */
  private abortController: AbortController | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(options: AgentLoopOptions<TSnapshot>) {
    this.options = options;
  }

  get busy(): boolean {
    return this.running;
  }

  get messages(): readonly AgentMessage[] {
    return this.history;
  }

  /**
   * Seed the conversation with restored history (e.g. transcript reloaded from
   * disk when a document reopens), so follow-up instructions keep their context.
   * No-op unless the loop is idle with an empty history.
   * Old messages over the compaction budget fold into a mechanical digest
   * (no LLM request on restore, guaranteeing zero latency).
   */
  restore(messages: readonly AgentMessage[]): void {
    if (this.running || this.history.length > 0 || messages.length === 0) return;
    // Edits-only runs persist an assistant message with no text; give it a placeholder
    // so the turn stays paired and providers never see an empty assistant content block.
    // Turn-limit notes persisted by older builds are stripped: they are stale
    // directives ("no more tools may be called") that poison every later run.
    const normalized = messages
      .filter((m) => !(m.role === "user" && m.text === TURN_LIMIT_NOTE))
      .map((m) =>
        m.role === "assistant" && !m.text ? { ...m, text: COMPLETED_VIA_TOOLS_TEXT } : m,
      );
    // Unanswered user messages (a failed or interrupted run persisted them without a
    // reply) must not re-enter the model context: trailing ones would pair with the
    // next instruction as one turn, adjacent ones read as a combined instruction
    this.history = normalized.filter(
      (m, i) => m.role !== "user" || (normalized[i + 1] && normalized[i + 1]!.role !== "user"),
    );
    if (this.history.length === 0) return;
    if (this.compactionEnabled()) {
      const { maxBytes, keepRecentBytes } = this.compactBudget();
      if (historySize(this.history) > maxBytes) {
        const cut = this.findCompactCut(keepRecentBytes);
        if (cut > 0) {
          const digest = mechanicalDigest(this.history.slice(0, cut));
          this.history = [
            { role: "user", text: `${COMPACT_SUMMARY_HEADER}\n${digest}` },
            { role: "assistant", text: COMPACT_SUMMARY_ACK },
            ...this.history.slice(cut),
          ];
        }
      }
    }
    this.trimHistory();
  }

  /** images: inline attachments for this user turn (vision input; see AgentImage) */
  run(instruction: string, images?: AgentImage[]): void {
    if (this.running || !instruction) return;
    this.setDirections([]);
    this.running = true;
    this.outcome = "running";
    this.lastFailure = "";
    this.lastCheckpoint = null;
    this.cancelled = false;
    this.turns = 0;
    this.finalizing = false;
    this.mutationSeen = false;
    this.inputParseFails = 0;
    this.lastTurnSig = "";
    this.identicalTurns = 0;
    this.allErrorTurns = 0;
    this.executedCalls = [];
    this.appliedDirections = [];
    this.verifyRetryUsed = false;
    this.abortController = new AbortController();
    let context: string;
    try { context = this.options.skill.buildContext?.() ?? ""; }
    catch (error) {
      this.history.push({ role: "user", text: sanitizeAgentPayload(instruction) });
      this.runUserMsg = this.history.at(-1)!;
      this.failRun(error instanceof Error ? error.message : String(error));
      return;
    }
    const format =
      this.options.formatUserMessage ??
      ((instr: string, ctx: string) => (ctx ? `${instr}\n\n${ctx}` : instr));
    let userMsg: AgentMessage;
    try { userMsg = {
      role: "user",
      text: format(instruction, context),
      ...(images?.length ? { images } : {}),
    }; } catch (error) {
      this.history.push({ role: "user", text: sanitizeAgentPayload(instruction) });
      this.runUserMsg = this.history.at(-1)!;
      this.failRun(error instanceof Error ? error.message : String(error));
      return;
    }
    void this.beginRun(userMsg);
  }

  /** Compact (if needed), push the user message, then start the turn. Compaction failure doesn't block the run. */
  private async beginRun(userMsg: AgentMessage): Promise<void> {
    const generation = this.generation;
    try {
      await this.maybeCompact();
    } catch {
      // Proceed with the run even if compaction fails (an over-budget history only costs more, it's still correct)
    }
    if (generation !== this.generation) return; // reset during compaction
    if (this.cancelled) {
      this.running = false;
      this.outcome = "stopped";
      this.options.events?.onDone?.({ text: "", cancelled: true, turnLimit: false });
      return;
    }
    // Leftover unanswered user message (a previous run failed before replying):
    // drop it so the model never sees two adjacent user turns as one combined instruction
    while (this.history.at(-1)?.role === "user") this.history.pop();
    this.trimHistory();
    // Reasoning echo only matters inside a run's own tool loop; drop it from
    // finished runs so it stops costing tokens on every later request.
    this.history = this.history.map((m) =>
      m.role === "assistant" && m.reasoning ? { ...m, reasoning: undefined } : m,
    );
    if (userMsg.role === "user") {
      userMsg = { ...userMsg, text: sanitizeAgentPayload(userMsg.text) };
    }
    this.runUserMsg = userMsg;
    this.history.push(userMsg);
    this.startTurn();
  }

  /** Failure is a terminal event; a future user request may explicitly resume it. */
  private reportFailure(error: string): void {
    this.outcome = "failed";
    this.lastFailure = error;
    this.options.events?.onError?.(error);
  }

  private failRun(error: string): void {
    if (!this.running) return;
    this.running = false;
    this.handle = null;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.history = this.history.filter(message => !(message.role === "user" && message.text === TURN_LIMIT_NOTE));
    // Even a synchronous snapshot/UI callback failure must leave complete
    // tool-use/result pairs for the next request. Unconfirmed work is never
    // represented as a successful or safely replayable edit.
    for (let i = 0; i < this.history.length; i++) {
      const message = this.history[i]!;
      if (message.role !== "assistant" || !message.toolCalls?.length) continue;
      let next = this.history[i + 1];
      if (next?.role !== "tool") {
        next = { role: "tool", results: [] };
        this.history.splice(i + 1, 0, next);
      }
      for (const call of message.toolCalls) {
        if (!next.results.some(result => result.id === call.id)) next.results.push({
          id: call.id, name: call.name, isError: true,
          output: "Execution was interrupted before a confirmed result. Inspect current state before deciding whether any operation remains necessary.",
        });
      }
    }
    this.checkpointFailedRun(error);
    this.reportFailure(error);
  }

  /**
   * Conversation checkpoint only. Reverting partial document mutations is
   * still the host's job in events.onError from snapshotBefore. Until the next
   * explicit user request reads the artifact, rollback success is unknown.
   */
  private checkpointFailedRun(error: string): void {
    const pending = this.directions;
    this.setDirections([]);
    const msg = this.runUserMsg;
    this.runUserMsg = null;
    if (!msg) return;
    const i = this.history.lastIndexOf(msg);
    if (i < 0) return;
    // Preserve the goal and completed, paired tool results. A model-stream
    // error has not executed this turn's pending calls, so they are absent.
    // Host rollback is asynchronous and domain-specific: never assert that
    // earlier edits are still applied (or that they were successfully undone).
    const note = "[Task interrupted — not completed]\n" +
      `Reason: ${error.slice(0, 1_000)}\n` +
      "Completed tool exchanges below are historical receipts, not proof of the artifact's current state. " +
      (this.mutationSeen
        ? "Some tools reported edits. The host may have rolled those edits back; their current application status is unknown. "
        : "No tool reported a completed artifact edit. ") +
      "Do not replay prior writes automatically. If the user asks to continue, recover the original request, inspect current artifact state, reuse supported research, then do only the remaining work.\n" +
      (pending.length ? `Pending user directions (not yet applied):\n${pending.join("\n")}\n` : "") +
      mechanicalDigest([
        ...this.history.slice(0, i).filter(message => message.role === "user" && message.text.startsWith(COMPACT_SUMMARY_PREFIX)),
        ...this.history.slice(i + 1),
      ], 12_000);
    this.lastCheckpoint = note;
    this.history.push({ role: "assistant", text: note });
  }

  // ── Context compaction: fold old conversation into a summary, keep recent messages verbatim ──

  private compactionEnabled(): boolean {
    return this.options.compaction !== false;
  }

  private compactBudget(): { maxBytes: number; keepRecentBytes: number } {
    const opt = this.options.compaction === false ? undefined : this.options.compaction;
    return {
      maxBytes: opt?.maxBytes ?? COMPACT_MAX_BYTES,
      keepRecentBytes: opt?.keepRecentBytes ?? COMPACT_KEEP_RECENT_BYTES,
    };
  }

  /**
   * Find the compaction cut at a user boundary: accumulate from the tail up to keepRecentBytes.
   * Returns the start index of the kept segment; if no suitable boundary exists,
   * fall back to keeping the last user turn.
   */
  private findCompactCut(keepRecentBytes: number): number {
    let kept = 0;
    let cut = -1;
    for (let i = this.history.length - 1; i >= 0; i--) {
      kept += messageSize(this.history[i]!);
      if (kept > keepRecentBytes && cut >= 0) break;
      if (this.history[i]!.role === "user") cut = i;
    }
    if (cut < 0) {
      for (let i = this.history.length - 1; i >= 0; i--) {
        if (this.history[i]!.role === "user") return i;
      }
    }
    return cut;
  }

  private async maybeCompact(): Promise<void> {
    if (!this.compactionEnabled()) return;
    const { maxBytes, keepRecentBytes } = this.compactBudget();
    if (historySize(this.history) <= maxBytes) return;
    const cut = this.findCompactCut(keepRecentBytes);
    if (cut <= 0) return; // no foldable prefix
    const generation = this.generation;
    const dropped = this.history.slice(0, cut);
    const opt = this.options.compaction === false ? undefined : this.options.compaction;
    let summary: string | null = null;
    if (!opt?.disableLlmSummary) summary = await this.summarizeViaLlm(dropped);
    // A reset may have cleared history or started a new conversation while
    // the summary was pending. Discard its result before touching that history.
    if (generation !== this.generation) return;
    if (!summary) summary = mechanicalDigest(dropped);
    this.history = [
      { role: "user", text: `${COMPACT_SUMMARY_HEADER}\n${summary}` },
      { role: "assistant", text: COMPACT_SUMMARY_ACK },
      ...this.history.slice(cut),
    ];
  }

  /** Hand the folded conversation to the model for a summary; returns null on failure/timeout (falls back to the mechanical digest). */
  private summarizeViaLlm(dropped: readonly AgentMessage[]): Promise<string | null> {
    // Slim down the summary request itself: pre-truncate tool outputs, strip images
    const slim: AgentMessage[] = dropped.map((m) => {
      if (m.role === "tool") {
        return {
          role: "tool" as const,
          results: m.results.map((r) => ({
            id: r.id,
            name: r.name,
            isError: r.isError,
            output: r.output.slice(0, SUMMARIZE_TOOL_OUTPUT_MAX),
          })),
        };
      }
      if (m.role === "user" && m.images?.length) return { role: "user" as const, text: m.text };
      return m.role === "assistant" ? { ...m, reasoning: undefined } : m;
    });
    return new Promise((resolve) => {
      let text = "";
      let settled = false;
      let handle: AgentStreamHandle | null = null;
      const finish = (v: string | null) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (this.handle === handle) this.handle = null;
        resolve(v);
      };
      const timer = setTimeout(() => {
        finish(null);
        handle?.cancel();
      }, SUMMARIZE_TIMEOUT_MS);
      try {
        // Attach to this.handle so cancel() can abort the summary request when the user clicks stop
        handle = this.options.transport.stream(
          {
            system: SUMMARIZE_SYSTEM,
            messages: [
              ...slim,
              { role: "user", text: "Compress the conversation above as instructed." },
            ],
            tools: [],
          },
          {
            onDelta: (t) => {
              text += t;
            },
            onToolCall: () => {
              /* the summary turn gets no tools */
            },
            onDone: () => finish(this.cancelled ? null : text.trim() || null),
            onError: () => finish(null),
          },
        );
        if (!settled) this.handle = handle;
      } catch {
        finish(null);
      }
    });
  }

  /**
   * When over budget mid-run (between tool turns), truncate stale tool outputs:
   * keep structure (tool_use/tool_result pairs intact), cut content only,
   * and keep the most recent N verbatim.
   */
  private squashStaleToolOutputs(): void {
    if (!this.compactionEnabled()) return;
    const { maxBytes } = this.compactBudget();
    if (historySize(this.history) <= maxBytes) return;
    let recent = 0;
    for (let i = this.history.length - 1; i >= 0; i--) {
      const m = this.history[i]!;
      if (m.role !== "tool") continue;
      recent++;
      if (recent <= STALE_TOOL_KEEP_RECENT) continue;
      m.results = m.results.map((r) => {
        // Stale captures (rendered pages/slides) are the heaviest payload and
        // the least useful once the model has acted on them: drop the pixels,
        // keep a note that a capture existed.
        const { images, ...rest } = r;
        const withoutImages: AgentToolResult = images?.length
          ? { ...rest, output: `${rest.output}\n…(${images.length} earlier capture(s) omitted)` }
          : rest;
        return withoutImages.output.length > STALE_TOOL_OUTPUT_MAX
          ? {
              ...withoutImages,
              output: `${withoutImages.output.slice(0, STALE_TOOL_OUTPUT_MAX)}\n…(output truncated: too long)`,
            }
          : withoutImages;
      });
    }
  }

  cancel(): void {
    if (!this.running) return;
    this.cancelled = true;
    this.setDirections([]);
    // abort lets long tools mid-execution (internal LLM loops etc.) stop promptly
    this.abortController?.abort();
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
      void this.finishTurn().catch((error: unknown) => this.failRun(error instanceof Error ? error.message : String(error)));
      return;
    }
    // the transport emits onDone after aborting, which finalizes the run
    this.handle?.cancel();
  }

  /** drop the conversation (e.g. when a different document is opened) */
  reset(): void {
    this.setDirections([]);
    this.generation++;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.abortController?.abort();
    this.handle?.cancel();
    this.handle = null;
    this.running = false;
    this.cancelled = false;
    this.history = [];
    this.outcome = "idle";
    this.lastFailure = "";
    this.lastCheckpoint = null;
    this.turnText = "";
    this.turns = 0;
    this.toolCalls = [];
    this.runUserMsg = null;
  }

  /** Runs at run boundaries only (restore / before a new user message): a long run's tail is all assistant/tool messages, and cutting mid-run would empty the request. */
  private trimHistory(): void {
    const max = this.options.maxHistory ?? DEFAULT_MAX_HISTORY;
    if (this.history.length <= max) return;
    // cut only at a user message so tool_use/tool_result pairs stay intact
    let i = this.history.length - max;
    while (i < this.history.length && this.history[i]!.role !== "user") i++;
    if (i >= this.history.length) return; // no user boundary in the window: keep history over budget
    const next = this.history.slice(i);
    if (this.runUserMsg && !next.includes(this.runUserMsg)) return;
    this.history = next;
  }

  private startTurn(retriesUsed = 0): void {
    if (!this.running) return;
    const generation = this.generation;
    this.turnText = "";
    this.turnReasoningOpaque = "";
    this.turnReasoningText = "";
    this.toolCalls = [];
    this.turnStopReason = null;
    // Some transports emit an extra onDone after cancel — this turn may finalize only once
    let settled = false;
    const finish = () => {
      void this.finishTurn().catch((error: unknown) => {
        if (generation === this.generation) this.failRun(error instanceof Error ? error.message : String(error));
      });
    };
    const failStream = (error: string, details?: { code?: string; retryable?: boolean }) => {
      if (generation !== this.generation || settled) return;
      settled = true;
      this.handle = null;
      const delays = this.options.transientRetryDelaysMs ?? EMPTY_STREAM_RETRY_DELAYS_MS;
      const requestedDelay = retriesUsed < 2 ? delays[retriesUsed] : undefined;
      const retryable = details?.retryable ?? /\(empty stream\)|ServiceUnavailableException|ThrottlingException|\b(?:HTTP\s*)?(?:429|502|503|504)\b|temporarily unavailable|overloaded/i.test(error);
      if (requestedDelay !== undefined && Number.isFinite(requestedDelay) && requestedDelay >= 0 && retryable && !this.cancelled) {
        // A model stream is only a proposal: this turn's tools have not run.
        // Discard partial arguments/text, retaining all prior executed pairs.
        this.turnText = "";
        this.toolCalls = [];
        this.options.events?.onText?.("");
        this.options.events?.onStatus?.({ text: `Connection interrupted; retrying model response (${retriesUsed + 1}/2). Completed actions will not be repeated.` });
        this.retryTimer = setTimeout(() => {
          this.retryTimer = null;
          if (generation !== this.generation || !this.running) return;
          if (this.cancelled) { finish(); return; }
          const directions = this.applyDirections();
          if (directions.length) this.options.events?.onTurnEnd?.(directions);
          if (generation === this.generation && this.running) this.startTurn(retriesUsed + 1);
        }, Math.min(requestedDelay, 30_000));
        return;
      }
      if (this.cancelled) { finish(); return; }
      this.failRun(error);
    };
    try {
      const handle = this.options.transport.stream(
      {
        system:
          runtimePreamble() +
          this.options.skill.systemPrompt +
          (this.options.systemSuffix?.() ?? ""),
        messages: [...this.history],
        tools: this.finalizing ? [] : this.options.skill.tools,
      },
      {
        onDelta: (text) => {
          if (generation !== this.generation || settled) return;
          this.turnText += text;
          this.options.events?.onText?.(this.turnText);
        },
        onReasoning: (text) => {
          if (generation !== this.generation || settled) return;
          // Opaque provider blobs (signed thinking blocks) are echoed back to
          // the model only; readable deltas go to the UI. When a transport
          // sends both, the opaque blob wins for the echo.
          if (text.startsWith(OPAQUE_REASONING_PREFIX)) {
            this.turnReasoningOpaque += text;
            return;
          }
          this.turnReasoningText += text;
          this.options.events?.onReasoning?.(this.turnReasoningText);
        },
        onStatus: (status) => {
          if (generation !== this.generation || settled) return;
          this.options.events?.onStatus?.(status);
        },
        onToolCall: (call) => {
          if (generation !== this.generation || settled) return;
          this.toolCalls.push(call);
        },
        onStopReason: (reason) => {
          if (generation !== this.generation || settled) return;
          this.turnStopReason = reason;
        },
        onDone: () => {
          if (generation !== this.generation || settled) return;
          settled = true;
          this.handle = null;
          finish();
        },
        onError: failStream,
      },
    );
      // Synchronous test/custom transports may already have completed and
      // started another turn; never replace that newer handle with this one.
      if (!settled && generation === this.generation && this.running) this.handle = handle;
    } catch (error) {
      failStream(error instanceof Error ? error.message : String(error));
    }
  }

  /** Compact a long *single* task at completed tool-exchange boundaries.
   * The initial request is pinned verbatim; source receipts remain attributed
   * and recent tool-use/result pairs are kept together, including reasoning.
   * This also sheds old assistant tool arguments/reasoning, which truncating
   * tool outputs alone never bounded. No extra model request is needed. */
  private compactActiveRun(): void {
    if (!this.compactionEnabled() || !this.runUserMsg) return;
    const { maxBytes, keepRecentBytes } = this.compactBudget();
    if (historySize(this.history) <= maxBytes) return;
    const original = this.runUserMsg;
    const originalIndex = this.history.indexOf(original);
    if (originalIndex < 0) return;
    let cut = -1;
    let kept = 0;
    for (let i = this.history.length - 1; i > originalIndex; i--) {
      kept += messageSize(this.history[i]!);
      const message = this.history[i]!;
      if (message.role === "assistant" && message.toolCalls?.length && this.history[i + 1]?.role === "tool") {
        if (cut >= 0 && kept > keepRecentBytes) break;
        cut = i;
      }
    }
    if (cut <= originalIndex + 1) return;
    const dropped = this.history.slice(0, cut).filter(message => message !== original);
    const recent = this.history.slice(cut);
    // Steering instructions are authoritative, not expendable tool output.
    const directions = dropped.filter((message): message is Extract<AgentMessage, { role: "user" }> =>
      message.role === "user" && message.text.startsWith("Updated directions from the user"));
    const pinnedDirections = this.appliedDirections.join("\n\n");
    const available = maxBytes - historySize(recent) - messageSize(original) - utf8Size(pinnedDirections) - 700;
    // A single huge current exchange or user attachment is indivisible. Keep
    // it rather than silently corrupting tool pairs or dropping user intent.
    if (available < 600) return;
    const digest = mechanicalDigest(dropped.filter(message => !directions.includes(message as never)), Math.min(12_000, Math.floor(available / 3)));
    const summary = `${COMPACT_SUMMARY_HEADER}\nHistorical receipts only; verify live artifact state before editing. Missing details require re-reading their source.\n${digest}` +
      (pinnedDirections ? `\n\nAuthoritative user updates, in order:\n${pinnedDirections}` : "");
    const next: AgentMessage[] = [
      { role: "user", text: summary },
      { role: "assistant", text: COMPACT_SUMMARY_ACK },
      original,
      ...recent,
    ];
    if (historySize(next) < historySize(this.history)) {
      this.history = next;
      this.options.events?.onStatus?.({ text: "Compacted earlier tool exchanges; retaining the request, source receipts, and recent work." });
    }
  }

  private async finishTurn(): Promise<void> {
    const { events, skill, captureSnapshot } = this.options;
    const toolCalls = this.toolCalls;
    let verificationFailed = false;

    // Claimed-action guard: before accepting a final text turn, let the skill
    // check the claims in it against the tools that actually ran this run.
    // A returned correction forces one more model turn (tools stay available,
    // so the model can perform the missing action or reword its claim).
    if (toolCalls.length === 0 && !this.cancelled && !this.finalizing && this.directions.length) {
      this.history.push({
        role: "assistant",
        text: this.turnText || "I received your updated directions.",
      });
      const directions = this.applyDirections();
      this.turns++;
      if (this.turns >= (this.options.maxTurns ?? DEFAULT_MAX_TURNS)) {
        this.finalizing = true;
        this.history.push({ role: "user", text: TURN_LIMIT_NOTE });
      }
      events?.onTurnEnd?.(directions);
      this.startTurn();
      return;
    }
    if (toolCalls.length === 0 && !this.cancelled && !this.finalizing) {
      // snapshot copy: the live array keeps growing if the corrective turn
      // runs more tools, and the hook must see the state at check time
      const correction =
        this.turnText && skill.verifyResponse
          ? skill.verifyResponse(this.turnText, [...this.executedCalls])
          : null;
      if (correction && !this.verifyRetryUsed) {
        this.verifyRetryUsed = true;
        this.history.push({ role: "assistant", text: this.turnText });
        this.history.push({ role: "user", text: correction });
        // No onTurnEnd here: UIs use it to seal the current assistant bubble,
        // which would keep the rejected claim visible. Without it, the
        // corrective turn's cumulative onText overwrites the bubble in place.
        this.startTurn();
        return;
      }
      if (correction) {
        verificationFailed = true;
        this.turnText = "The task could not be verified against completed tool actions. Any claimed file, download, or document change remains unconfirmed. Inspect the current document and retry the unfinished operation.";
        events?.onText?.(this.turnText);
      }
    }

    // final turn: no tools requested, the user stopped the run, or the
    // no-tools finalizing turn after hitting the limit
    // (a cancelled turn drops its tool calls — no results would follow)
    if (toolCalls.length === 0 || this.cancelled || this.finalizing) {
      // The turn-limit note has served its purpose once the finalizing turn
      // ends. Left in history it would tell every later run "no more tools may
      // be called" — a stale directive models obey (or worse, echo verbatim
      // over and over; see public issue about BYOK models repeating it).
      if (this.finalizing) {
        for (let i = this.history.length - 1; i >= 0; i--) {
          const m = this.history[i]!;
          if (m.role === "user" && m.text === TURN_LIMIT_NOTE) {
            this.history.splice(i, 1);
            break;
          }
        }
      }
      // Models often end a tool-using run with an empty text turn ("I'm done").
      // Leaving assistant text empty in history then poisons the next user
      // prompt: Anthropic rejects empty content arrays, Gemini rejects empty
      // parts, and OpenAI-compatible routes send content:null with no tool_calls —
      // all of which make follow-up turns fail or return empty again (see
      // genoffice#12 / #22: first prompt works, second shows "no summary").
      // Same normalization as restore(), applied unconditionally: cancelled and
      // read-only empty turns poison follow-ups just the same. onDone still
      // reports the raw turn text so app UIs keep their localized fallbacks
      // instead of surfacing this English placeholder.
      const emptyReply = this.cancelled
        ? "(The task was stopped. Inspect the current document before continuing.)"
        : this.finalizing || this.turnStopReason === "max_tokens"
          ? "(The task is incomplete because a response or turn limit was reached. Inspect the current document before continuing; do not assume edits were completed.)"
          : this.executedCalls.some(call => call.ok)
            ? COMPLETED_VIA_TOOLS_TEXT
            : "(No tool action completed and no text reply was returned.)";
      this.history.push({ role: "assistant", text: this.turnText || emptyReply });
      this.setDirections([]);
      this.running = false;
      this.runUserMsg = null;
      this.outcome = this.cancelled
        ? "stopped"
        : this.finalizing || this.turnStopReason === "max_tokens" || verificationFailed
          ? "partial"
          : "completed";
      events?.onDone?.({
        text: this.turnText,
        cancelled: this.cancelled,
        turnLimit: this.finalizing,
        // set only when true so exact-shape consumers/tests stay unaffected
        ...(this.turnStopReason === "max_tokens" && !this.cancelled ? { truncated: true } : {}),
        ...(verificationFailed ? { unverified: true } : {}),
      });
      return;
    }

    // Strip turn-local execution hints (inputError/truncated) from the stored
    // history: they are not model context, and transports with strict message
    // schemas (the Electron IPC bridge) reject unknown tool-call keys when the
    // history is echoed back on the next turn. The OpenAI-compatible stream
    // paths attach `inputError: undefined` on every parsed call, so without
    // this the second turn of any custom-provider agent run fails validation.
    const reasoningEcho = this.turnReasoningOpaque || this.turnReasoningText;
    this.history.push({
      role: "assistant",
      text: this.turnText,
      toolCalls: toolCalls.map(({ id, name, input }) => ({ id, name, input })),
      // interleaved-thinking models degrade in tool loops unless their reasoning is echoed back
      ...(reasoningEcho ? { reasoning: reasoningEcho } : {}),
    });
    const generation = this.generation;
    const results: AgentToolResult[] = [];
    this.history.push({ role: "tool", results });
    let turnMutated = false;
    // Run one executed tool call: raises the execution error into a result so
    // a failing tool never aborts the turn.
    const execute = async (call: AgentToolCall): Promise<ToolExecution> => {
      if (generation !== this.generation || this.abortController?.signal.aborted)
        return {
          output: "Task stopped before this tool started.",
          isError: true,
          summary: call.name,
        };
      if (this.directions.length)
        return {
          output:
            "Not executed: the user supplied updated directions. Re-plan with those directions and inspect current state before editing.",
          isError: true,
          skipped: true,
          summary: "Skipped after updated directions",
        };
      try {
        return await skill.executeTool(call, this.abortController?.signal);
      } catch (e) {
        return {
          output: e instanceof Error ? e.message : String(e),
          isError: true,
          summary: call.name,
        };
      }
    };
    // Book-keeping after a call finished, in call order (results must pair
    // with tool_use blocks in the order the model emitted them).
    const record = (
      call: AgentToolCall,
      execution: ToolExecution,
      snapshot: TSnapshot | undefined,
    ): void => {
      if (!execution.skipped) this.executedCalls.push({ name: call.name, ok: !execution.isError });
      const firstMutation = !!execution.mutated && !this.mutationSeen;
      if (execution.mutated) {
        this.mutationSeen = true;
        turnMutated = true;
      }
      results.push({
        id: call.id,
        name: call.name,
        output: execution.output,
        isError: execution.isError,
        ...(execution.images?.length ? { images: execution.images } : {}),
      });
      events?.onToolExecuted?.({
        call,
        execution,
        snapshotBefore: firstMutation ? snapshot : undefined,
      });
    };
    const readOnlyNames = new Set(skill.tools.filter((t) => t.readOnly).map((t) => t.name));
    // Returns true when the call was consumed without executing (stop pressed
    // or unusable input); the paired error result is already recorded.
    const consumedWithoutRun = (call: AgentToolCall): boolean => {
      // The user hit stop while an earlier tool was running: skip remaining tools,
      // but fill in paired error results to keep tool_use/tool_result pairs valid for the next request
      if (this.cancelled) {
        results.push({
          id: call.id,
          name: call.name,
          output: "(the user stopped the run; this tool was not executed)",
          isError: true,
        });
        return true;
      }
      // Unusable input (truncated by the token limit, or JSON that failed to parse):
      // don't execute; feed a targeted error back so the model retries correctly
      if (call.truncated || call.inputError) {
        const output = call.truncated
          ? "Tool arguments were cut off by the output length limit; the tool was not executed. Split this operation into several smaller tool calls (less content per call) and try again."
          : `Tool input JSON failed to parse; the tool was not executed: ${call.inputError}\nFix the arguments (make sure quotes inside strings are escaped) and call again.`;
        results.push({ id: call.id, name: call.name, output, isError: true });
        events?.onToolExecuted?.({
          call,
          execution: { output, isError: true, summary: call.name },
        });
        return true;
      }
      return false;
    };

    let i = 0;
    while (i < toolCalls.length) {
      const call = toolCalls[i]!;
      if (consumedWithoutRun(call)) {
        i++;
        continue;
      }

      // A run of consecutive read-only calls (reads, searches, lookups)
      // executes concurrently: none of them changes the artifact, so their
      // relative order cannot matter, and the model usually asks for several
      // at once. Everything else keeps strict order.
      if (readOnlyNames.has(call.name)) {
        const batch: AgentToolCall[] = [call];
        let j = i + 1;
        while (
          j < toolCalls.length &&
          readOnlyNames.has(toolCalls[j]!.name) &&
          !toolCalls[j]!.truncated &&
          !toolCalls[j]!.inputError
        ) {
          batch.push(toolCalls[j]!);
          j++;
        }
        for (const b of batch) events?.onToolStart?.(b);
        // Read-only tools should never mutate; keep the pre-state anyway so a
        // mis-flagged tool still gets a roll-back point.
        const batchSnapshot = !this.mutationSeen ? captureSnapshot?.() : undefined;
        const executions = await mapConcurrent(batch, execute, 4);
        if (generation !== this.generation) return; // reset while tools were running
        executions.forEach((execution, k) => record(batch[k]!, execution, batchSnapshot));
        i = j;
        continue;
      }

      events?.onToolStart?.(call);
      const snapshot = !this.mutationSeen ? captureSnapshot?.() : undefined;
      const execution = await execute(call);
      if (generation !== this.generation) return; // reset while a tool was running
      record(call, execution, snapshot);
      i++;
    }

    // Cancelled while tools were executing: finish immediately, no further model request
    if (this.cancelled) {
      this.setDirections([]);
      this.running = false;
      this.runUserMsg = null;
      this.outcome = "stopped";
      events?.onDone?.({ text: this.turnText, cancelled: true, turnLimit: false });
      return;
    }

    // Pair every tool result before adding a new user message. Pending operations
    // were skipped; any operation already in flight was allowed to settle once.
    const directions = this.applyDirections();
    // Count failed repair rounds, not parallel calls in a single response.
    // A three-call truncated batch must get a chance to split its arguments.
    this.inputParseFails = !directions.length && toolCalls.every(call => call.inputError || call.truncated)
      ? this.inputParseFails + 1 : 0;

    // Bad-input retries hit the cap: abort instead of burning more turns
    if (!directions.length && this.inputParseFails >= MAX_INPUT_PARSE_RETRIES) {
      this.failRun(
        `Tool input remained unusable for ${MAX_INPUT_PARSE_RETRIES} repair rounds. The task was interrupted; you can ask to continue after inspecting the current state.`,
      );
      return;
    }

    // A turn where every tool call failed makes no progress; a long streak
    // (unknown-tool loops from malformed BYOK streams, hallucinated tools)
    // would otherwise burn the whole turn budget re-erroring.
    this.allErrorTurns =
      !directions.length && results.every((r) => r.isError) ? this.allErrorTurns + 1 : 0;
    if (this.allErrorTurns >= MAX_ALL_ERROR_TURNS) {
      this.failRun(
        `Every tool call failed for ${MAX_ALL_ERROR_TURNS} turns in a row. The task was interrupted; its request and progress are retained for recovery.`,
      );
      return;
    }

    // Identical-turn guard: a model (typically a weak BYOK/local endpoint)
    // re-emitting the same text, tool calls AND tool outputs is looping, not
    // progressing. Turns that mutated the artifact are exempt (repeating an
    // identical edit is legitimate progress), and changing outputs break the
    // streak (so poll-style tools survive).
    const turnSig = JSON.stringify([
      this.turnText,
      toolCalls.map(({ name, input }) => [name, input]),
      results.map((r) => r.output),
    ]);
    if (turnSig === this.lastTurnSig && !turnMutated) {
      if (++this.identicalTurns >= MAX_IDENTICAL_TURNS) {
        this.failRun(
          "The model repeated the same turn without progress. The task was interrupted; its request and progress are retained for recovery.",
        );
        return;
      }
    } else {
      this.lastTurnSig = turnSig;
      this.identicalTurns = 0;
    }

    this.turns++;
    if (this.turns >= (this.options.maxTurns ?? DEFAULT_MAX_TURNS)) {
      // Don't throw away the context already gathered: append one no-tools turn for a partial answer
      this.finalizing = true;
      this.history.push({ role: "user", text: TURN_LIMIT_NOTE });
    }
    // Long runs (e.g. page-by-page generation) over budget mid-way: truncate stale tool outputs so each turn doesn't resend a huge payload
    this.squashStaleToolOutputs();
    this.compactActiveRun();
    events?.onTurnEnd?.(directions);
    if (generation === this.generation && this.running) this.startTurn();
  }
}

/**
 * Redact secret-looking tokens from an outgoing user message so accidentally
 * pasted API keys, URL credentials, and password assignments don't reach
 * remote model APIs verbatim.
 *
 * Imported from public PR #32 (BuiltByHarshil), with the credential pattern
 * narrowed to URL userinfo (scheme://user:pass@host) so ordinary "a:b@c"
 * prose is never rewritten.
 */
export function sanitizeAgentPayload(payload: string): string {
  return payload
    .replace(/\b(?:sk-|AIza|ghp_|secret_)[A-Za-z0-9_-]{16,}/g, "[REDACTED_API_KEY]")
    .replace(/([a-z][a-z0-9+.-]*:\/\/[^\s:@/]+):[^\s@/]+@/gi, "$1:[REDACTED_CREDENTIALS]@")
    .replace(
      /(password|passwd|secret_key|private_key)(\s*[:=]\s*)["'][^"']+["']/gi,
      '$1$2"[REDACTED_SECURE_TOKEN]"',
    );
}
