import type { PileStructure } from "./types";

const DEFAULTS = [
  "Summarize this set for a colleague who has not read it.",
  "What dates, deadlines, and hearings appear?",
  "Who are the parties, and what claims or defenses are at issue?",
];

/** Starter questions for an indexed working set — Focus first, then structure, then defaults. */
export function suggestQuestions(
  structure: PileStructure | null,
  focus: string | null | undefined,
  limit = 5,
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const add = (raw: string) => {
    const q = raw.replace(/\s+/g, " ").trim().replace(/[?!.]+$/, "");
    if (!q || out.length >= limit) return;
    const key = q.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push(q.endsWith("?") ? q : `${q}?`);
  };

  const focusText = focus?.trim();
  if (focusText) {
    add(`Summarize this set with a focus on ${focusText.replace(/[?!.]+$/, "")}`);
  }

  for (const issue of structure?.issues ?? []) add(`What do these documents say about ${issue}`);
  for (const party of (structure?.parties ?? []).slice(0, 2)) {
    add(`What is ${party}'s role and posture in these documents`);
  }
  for (const q of DEFAULTS) add(q);

  return out.slice(0, limit);
}
