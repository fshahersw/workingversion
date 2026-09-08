import type { ChoiceRequest, Round } from "../chat-types.ts";

export type ResearchActivitySummary = {
  phase: string;
  rounds: number;
  agents: number;
  tools: number;
  elapsedMs: number | null;
  done: boolean;
};

export function summarizeResearchActivity(
  rounds: Round[],
  settled: boolean,
  now = Date.now(),
): ResearchActivitySummary {
  const latest = rounds[rounds.length - 1];
  const agents = rounds.reduce((total, round) => total + Object.keys(round.agents).length, 0);
  const tools = rounds.reduce(
    (total, round) =>
      total +
      Object.values(round.agents).reduce((roundTotal, agent) => roundTotal + agent.tools.length, 0),
    0,
  );
  const starts = rounds
    .map((round) => round.startedAt)
    .filter((value): value is number => typeof value === "number");
  const ends = rounds
    .map((round) => round.completedAt)
    .filter((value): value is number => typeof value === "number");
  const start = starts.length ? Math.min(...starts) : null;
  // Live: measure to now. Settled: only a recorded completion counts; a settled
  // round without one (older saved turns) reports no elapsed time rather than
  // the time since it was reopened.
  const end = settled ? (ends.length ? Math.max(...ends) : null) : now;
  return {
    phase: latest?.phase?.trim() || (settled ? "Research complete" : "Reviewing the question"),
    rounds: rounds.length,
    agents,
    tools,
    elapsedMs: start == null || end == null ? null : Math.max(0, end - start),
    done: settled,
  };
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export function normalizeChoiceRequest(value: unknown): ChoiceRequest | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Record<string, unknown>;
  const id = text(raw.id) || text(raw.request_id);
  const prompt = text(raw.prompt) || text(raw.question) || text(raw.title);
  const source = Array.isArray(raw.options)
    ? raw.options
    : Array.isArray(raw.choices)
      ? raw.choices
      : [];
  const options = source
    .map((option, index) => {
      if (typeof option === "string") {
        const label = option.trim();
        return label ? { id: String(index + 1), label } : null;
      }
      if (!option || typeof option !== "object") return null;
      const row = option as Record<string, unknown>;
      const label = text(row.label) || text(row.text) || text(row.title);
      if (!label) return null;
      return {
        id: text(row.id) || text(row.value) || String(index + 1),
        label,
        ...(text(row.description) ? { description: text(row.description) } : {}),
      };
    })
    .filter((option): option is ChoiceRequest["options"][number] => option !== null);
  if (!id || !prompt || options.length < 2) return null;
  return { id, prompt, options };
}

export function choiceResponseText(request: ChoiceRequest, optionId: string): string {
  const option = request.options.find((candidate) => candidate.id === optionId);
  return option ? `Choice ${request.id}: ${option.label}` : "";
}
