export type PileJobId = "holdings" | "deadlines" | "chronology" | "conflicts";

export type PileJob = {
  id: PileJobId;
  label: string;
  query: string;
  instructions: string;
};

export const PILE_JOBS: PileJob[] = [
  {
    id: "holdings",
    label: "Holdings",
    query: "What did the court hold, grant, deny, or order in these documents?",
    instructions: `JOB: holdings
Answer as a markdown table with columns: Ruling | What was granted or denied | Who | Source.
One row per distinct holding. Every row must end with an [Sn] cite from the retrieved pages.
If a document has no holding, omit it. If none, say none found.`,
  },
  {
    id: "deadlines",
    label: "Deadlines",
    query: "Extract every deadline, hearing date, and date by which a party must act.",
    instructions: `JOB: deadlines
Answer as a markdown table with columns: Date | Who | Obligation | Source.
Use ISO-like or the date as written. Every row must cite [Sn]. If none, say none found.`,
  },
  {
    id: "chronology",
    label: "Chronology",
    query: "Build a chronology of material events described in these documents.",
    instructions: `JOB: chronology
Answer as a markdown table with columns: Date | Event | Source.
Oldest first. Every row must cite [Sn]. Skip undated color. If none, say none found.`,
  },
  {
    id: "conflicts",
    label: "Conflicts",
    query: "Where do these documents disagree, and what does each one say?",
    instructions: `JOB: conflicts
Answer as a markdown table with columns: Issue | Document A | Document B | Source.
Cite both sides with [Sn] tags. If only one document speaks, say so. If they agree, write one row: no material conflict.`,
  },
];

export function pileJob(id: string | null | undefined): PileJob | null {
  return PILE_JOBS.find((j) => j.id === id) ?? null;
}
