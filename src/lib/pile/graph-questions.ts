// Questions the knowledge graph asks on the reader's behalf. Each one names
// the entity, its kind, the witness(es) whose testimony it comes from, and the
// relationships the graph already knows, so retrieval lands on the right pages
// and the answer is about this node rather than the whole deposition.
// No `@/` imports: runs under the Node test runner.
import type { DepGraphNode } from "./deposition-analysis.ts";

export type GraphAskKind = "testimony" | "relationships" | "conflicts" | "timeline" | "witnesses";

export type GraphAskContext = {
  label: string;
  kind: DepGraphNode["kind"];
  /** Witness names (or file stems) whose transcripts mention this node. */
  witnesses: string[];
  /** Direct relationships from the graph: "<relation> <other label>". */
  neighbors: { relation: string; other: string; conflict?: boolean }[];
  /** page:line cites already attached to this node's edges. */
  cites: string[];
};

const KIND_NOUN: Record<DepGraphNode["kind"], string> = {
  person: "this person",
  org: "this organization",
  doc: "this document or exhibit",
  theme: "this topic",
  event: "this event",
};

function list(items: string[], max: number): string {
  const unique = [...new Set(items.map((s) => s.trim()).filter(Boolean))];
  const head = unique.slice(0, max);
  const rest = unique.length - head.length;
  return rest > 0 ? `${head.join(", ")} and ${rest} more` : head.join(", ");
}

function witnessClause(witnesses: string[]): string {
  const names = list(witnesses, 3);
  if (!names) return "the testimony";
  return witnesses.length === 1 ? `${names}'s testimony` : `the testimony of ${names}`;
}

function citeClause(cites: string[]): string {
  const shown = list(cites, 4);
  return shown ? ` Start from ${shown}.` : "";
}

/** One targeted question per lens. Always asks for page:line citations. */
export function graphQuestion(kind: GraphAskKind, ctx: GraphAskContext): string {
  const who = witnessClause(ctx.witnesses);
  const relations = list(
    ctx.neighbors.map((n) => `${n.relation} ${n.other}`),
    4,
  );
  const cites = citeClause(ctx.cites);
  switch (kind) {
    case "testimony":
      return `What does ${who} establish about ${ctx.label} (${KIND_NOUN[ctx.kind]})? Quote the key statements and give page:line cites for each.${cites}`;
    case "relationships":
      return relations
        ? `In ${who}, how is ${ctx.label} connected to ${relations}? Explain each relationship in the witness's own words with page:line cites.${cites}`
        : `In ${who}, who and what is ${ctx.label} connected to, and how? Cite page:line for each connection.${cites}`;
    case "conflicts": {
      const conflictPeers = list(
        ctx.neighbors.filter((n) => n.conflict).map((n) => n.other),
        3,
      );
      return conflictPeers
        ? `Where does ${who} about ${ctx.label} conflict with or contradict ${conflictPeers}? Quote both sides with page:line cites and say which reading the record supports.${cites}`
        : `Where is ${who} about ${ctx.label} internally inconsistent, hedged, or contradicted elsewhere in the record? Quote the passages with page:line cites.${cites}`;
    }
    case "timeline":
      return `Lay out, in date order, every event in ${who} that involves ${ctx.label}. Give the date as stated, what happened, and a page:line cite for each entry.${cites}`;
    case "witnesses":
      return ctx.witnesses.length > 1
        ? `Compare what ${list(ctx.witnesses, 4)} each say about ${ctx.label}. Note where they agree, where they differ, and cite page:line for each witness.${cites}`
        : `Which other witnesses discuss ${ctx.label}, and does their account match ${who}? Cite page:line for each.${cites}`;
  }
}
