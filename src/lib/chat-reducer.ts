// ============================================================================
// Chat message reducer (pure, no React). Shared by the research chat hook and
// the Drafts assistant hook, and unit-tested without a DOM. Every import is
// relative so the node test runner can load it.
// ============================================================================
import type { Artifact, ChoiceAnswer, Message, Round, Source, ToolCall } from "./chat-types.ts";
import { normalizeChoiceRequest } from "./agents/research-activity.ts";
import type { SSEEvent } from "./orchestrate.ts";

export type ChatAction =
  | { type: "user"; id: string; text: string }
  | { type: "assistant_start"; id: string }
  | { type: "sse"; id: string; evt: SSEEvent }
  | { type: "delta_flush"; id: string; text: string }
  | { type: "thinking"; id: string; text: string }
  | { type: "reasoning"; id: string; text: string }
  | { type: "followups"; id: string; followups: string[] }
  | { type: "proposal_applied"; id: string }
  | { type: "hydrate"; messages: Message[] }
  | { type: "choice_resume"; id: string; answer: ChoiceAnswer }
  | { type: "reset" };

export function emptyAssistant(id: string): Message {
  return {
    id,
    role: "assistant",
    text: "",
    rounds: [],
    sources: [],
    answer: "",
    status: "thinking",
  };
}

/** The chat message reducer; shared with the Drafts assistant hook. */
export function reduceChatMessages(state: Message[], a: ChatAction): Message[] {
  switch (a.type) {
    case "user": {
      // Moving on to a new question closes any clarification panel that was
      // still open: it renders as "Skipped" and can no longer be answered, so
      // a late answer cannot rewrite an earlier message.
      const closed = state.map((m) =>
        m.role === "assistant" && m.choice && !m.choice.answered && !m.choice.dismissed
          ? { ...m, choice: { ...m.choice, dismissed: true } }
          : m,
      );
      return [
        ...closed,
        {
          id: a.id,
          role: "user",
          text: a.text,
          rounds: [],
          sources: [],
          answer: "",
          status: "done",
        },
      ];
    }
    case "assistant_start":
      return [...state, emptyAssistant(a.id)];
    case "delta_flush":
      return state.map((m) =>
        m.id === a.id && m.role === "assistant"
          ? { ...m, answer: m.answer + a.text }
          : m,
      );
    case "thinking":
      return state.map((m) => {
        if (m.id !== a.id || m.role !== "assistant") return m;
        // Each server narration is one line ("\n"-prefixed after the first);
        // RAF batching may deliver several at once, so split and stamp each.
        const now = Date.now();
        const lines = a.text
          .split("\n")
          .map((line) => line.trim())
          .filter(Boolean)
          .map((text) => ({ text, at: now }));
        return {
          ...m,
          thinking: (m.thinking ?? "") + a.text,
          narration: lines.length ? [...(m.narration ?? []), ...lines] : m.narration,
        };
      });
    case "reasoning":
      return state.map((m) =>
        m.id === a.id && m.role === "assistant"
          ? { ...m, reasoning: (m.reasoning ?? "") + a.text }
          : m,
      );
    case "sse":
      return state.map((m) =>
        m.id === a.id && m.role === "assistant" ? applyEvent(m, a.evt) : m,
      );
    case "hydrate":
      return a.messages;
    case "choice_resume":
      return state.map((m) => {
        if (m.id !== a.id || m.role !== "assistant") return m;
        const choice = m.choice
          ? { ...m.choice, answered: a.answer }
          : {
              id: a.answer.id,
              prompt: "",
              options: [],
              answered: a.answer,
            };
        return {
          ...emptyAssistant(m.id),
          choice,
          status: "thinking" as const,
        };
      });
    case "proposal_applied":
      return state.map((m) =>
        m.id === a.id && m.role === "assistant" && m.proposal
          ? { ...m, proposal: { ...m.proposal, appliedAt: Date.now() } }
          : m,
      );
    case "followups":
      return state.map((m) =>
        m.id === a.id && m.role === "assistant"
          ? { ...m, followups: a.followups }
          : m,
      );
    case "reset":
      return [];
    default:
      return state;
  }
}

export function applyEvent(m: Message, e: SSEEvent): Message {
  const d = (e.data ?? {}) as Record<string, unknown>;
  switch (e.event) {
    case "run":
      return m;
    case "mode":
      return { ...m, mode: d.mode ? String(d.mode) : m.mode, modeReason: d.reason ? String(d.reason) : m.modeReason };
    case "round": {
      const roundNumber = Number(d.round) || m.rounds.length + 1;
      const existing = m.rounds.find((candidate) => candidate.round === roundNumber);
      const now = Date.now();
      const round: Round = {
        round: roundNumber,
        phase: d.phase ? String(d.phase) : undefined,
        reasoning: String(d.reasoning ?? ""),
        scratch_note: d.scratch_note as string | undefined,
        done: Boolean(d.done),
        startedAt: existing?.startedAt ?? now,
        completedAt: d.done ? now : existing?.completedAt,
        dispatch:
          (d.dispatch as { agent: string; focus: string }[] | undefined) ?? [],
        agents: {},
      };
      for (const dp of round.dispatch) {
        round.agents[dp.agent] = {
          agent: dp.agent,
          focus: dp.focus,
          status: "running",
          tools: [],
        };
      }
      const rounds = existing
        ? m.rounds.map((r) =>
            r.round === round.round
              ? { ...r, ...round, agents: { ...r.agents, ...round.agents } }
              : r,
          )
        : [...m.rounds, round];
      return { ...m, rounds };
    }
    case "agent": {
      const rn = Number(d.round);
      const agent = String(d.agent);
      return mapRound(m, rn, (r) => ({
        ...r,
        agents: {
          ...r.agents,
          [agent]: r.agents[agent] ?? {
            agent,
            focus: String(d.focus ?? ""),
            status: "running",
            tools: [],
          },
        },
      }));
    }
    case "tool_call": {
      const rn = Number(d.round);
      const agent = String(d.agent);
      const id = d.id as string | undefined;
      const tc: Partial<ToolCall> & { tool: string } = {
        id,
        tool: String(d.tool ?? ""),
        query: d.query as string | undefined,
        scope: d.scope as string | undefined,
        hits: d.hits as number | undefined,
        ...(typeof d.ms === "number" ? { ms: d.ms } : {}),
        ...(Array.isArray(d.hosts) ? { hosts: (d.hosts as unknown[]).filter((h): h is string => typeof h === "string") } : {}),
        ...(d.error === "timeout" || d.error === "error" ? { error: d.error } : {}),
      };
      return mapRound(m, rn, (r) => {
        const ex = r.agents[agent] ?? {
          agent,
          focus: "",
          status: "running" as const,
          tools: [],
        };
        // Upsert by tool-use id: a call emits once when it STARTS (no hits) and
        // again when it COMPLETES (with hits). Merge into one row so the timeline
        // shows a live "searching…" state that fills in its result, not two rows.
        const i = id ? ex.tools.findIndex((t) => t.id === id) : -1;
        // A real completion (numeric hits, no error) clears an earlier timeout
        // mark: the loop stopped waiting, but the call finished after all.
        const settled = typeof tc.hits === "number" && !tc.error;
        const tools =
          i >= 0
            ? ex.tools.map((t, j) =>
                j === i ? { ...t, ...tc, ...(settled ? { error: undefined } : {}) } : t,
              )
            : [...ex.tools, { ...tc, at: Date.now() }];
        return {
          ...r,
          agents: { ...r.agents, [agent]: { ...ex, tools } },
        };
      });
    }
    case "agent_done": {
      const rn = Number(d.round);
      const agent = String(d.agent);
      return mapRound(m, rn, (r) => {
        const ex = r.agents[agent];
        if (!ex) return r;
        return {
          ...r,
          agents: {
            ...r.agents,
            [agent]: {
              ...ex,
              status: "done",
              summary: d.summary as string | undefined,
              count: d.count as number | undefined,
              citations: d.citations as string[] | undefined,
            },
          },
        };
      });
    }
    case "sources": {
      const sources = (d.sources as Source[] | undefined) ?? [];
      return { ...m, sources };
    }
    case "writer_start":
      // Research is over when the writer starts: stamp the rounds so the
      // elapsed time is fixed (and survives a reopen) instead of ticking.
      return {
        ...m,
        status: "writing",
        collapseTimeline: true,
        rounds: completeRounds(m.rounds),
        deliverable: d.deliverable ? String(d.deliverable) : m.deliverable,
      };
    case "delta":
      // Streaming text is batched outside the reducer via RAF;
      // see useChat.send. We still tolerate raw deltas here.
      return { ...m, answer: m.answer + ((d.text as string) ?? "") };
    case "verification":
      return {
        ...m,
        verification: {
          factsChecked: Number(d.factsChecked) || 0,
          factsVerified: Number(d.factsVerified) || 0,
          unverified: (d.unverified as string[] | undefined) ?? [],
          orphanRefs: (d.orphanRefs as string[] | undefined) ?? [],
          ...(d.faithfulness && typeof d.faithfulness === "object"
            ? { faithfulness: d.faithfulness as NonNullable<Message["verification"]>["faithfulness"] }
            : {}),
        },
      };
    case "artifact": {
      const incoming = (d.artifacts as Artifact[] | undefined) ?? [];
      if (!incoming.length) return m;
      // Upsert by id so a re-emitted artifact replaces rather than duplicates.
      const byId = new Map((m.artifacts ?? []).map((x) => [x.id, x]));
      for (const a of incoming) byId.set(a.id, a);
      return { ...m, artifacts: [...byId.values()] };
    }
    case "choice": {
      const choice = normalizeChoiceRequest(d.choice ?? d);
      return choice ? { ...m, choice } : m;
    }
    case "proposal": {
      const material = typeof d.material === "string" ? d.material : "";
      if (!material.trim()) return m;
      return {
        ...m,
        proposal: {
          material,
          target: d.target === "selection" ? "selection" : "cursor",
          ...(typeof d.note === "string" && d.note ? { note: d.note } : {}),
          ...(m.proposal?.appliedAt ? { appliedAt: m.proposal.appliedAt } : {}),
        },
      };
    }
    case "done":
      return {
        ...m,
        status: "done",
        collapseTimeline: true,
        rounds: completeRounds(m.rounds),
        // A user Stop (or a stream that ended without a terminal event) keeps
        // the streamed text but is flagged so the timeline can say so.
        ...(d.status === "stopped" || d.status === "ended" ? { stopped: true } : {}),
      };
    case "error":
      return {
        ...m,
        status: "error",
        error: (d.message as string) ?? "Something went wrong.",
      };
    default:
      return m;
  }
}

/** Mark every round finished (once); keeps an existing completion time. */
function completeRounds(rounds: Round[]): Round[] {
  const now = Date.now();
  return rounds.map((r) => (r.done && r.completedAt ? r : { ...r, done: true, completedAt: r.completedAt ?? now }));
}

function mapRound(m: Message, n: number, fn: (r: Round) => Round): Message {
  return { ...m, rounds: m.rounds.map((r) => (r.round === n ? fn(r) : r)) };
}

/**
 * RAF-batched channel for a streamed text field: coalesces deltas into one
 * dispatch per frame. Shared by the research and Drafts chat hooks.
 */
export function makeStreamChannel(flushTo: (text: string) => void): {
  push: (text: string) => void;
  flush: () => void;
} {
  let buf = "";
  let scheduled = false;
  const flush = () => {
    scheduled = false;
    if (!buf) return;
    const t = buf;
    buf = "";
    flushTo(t);
  };
  const push = (text: string) => {
    buf += text;
    if (scheduled) return;
    scheduled = true;
    if (typeof requestAnimationFrame !== "undefined") requestAnimationFrame(flush);
    else setTimeout(flush, 40);
  };
  return { push, flush };
}
