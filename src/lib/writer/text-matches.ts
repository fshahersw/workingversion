import type { Node, Mark } from "@tiptap/pm/model";

export type TextSpan = { from: number; to: number; marks: readonly Mark[] };
export type TextMatch = TextSpan & { text: string; runs: TextSpan[] };

/** Literal matches across formatting runs, never across structural/deletion boundaries.
 * `pos` is the position BEFORE node (use -1 for the document). */
export function findTextMatches(
  node: Node,
  pos: number,
  needle: string,
  matchCase = true,
): TextMatch[] {
  if (!needle) return [];
  const matches: TextMatch[] = [];
  const pattern = new RegExp(
    needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
    matchCase ? "gu" : "giu",
  );
  const visit = (block: Node, at: number) => {
    if (block.type.name === "docProtected" || block.attrs.blockRevision?.kind === "del") return;
    if (!block.isTextblock) {
      block.forEach((child, offset) => visit(child, at + 1 + offset));
      return;
    }
    let text = "";
    let runs: TextSpan[] = [];
    const flush = () => {
      pattern.lastIndex = 0;
      for (const match of text.matchAll(pattern)) {
        const from = runs[0].from + match.index!;
        const to = from + match[0].length;
        const selected = runs
          .filter((r) => r.to > from && r.from < to)
          .map((r) => ({ ...r, from: Math.max(from, r.from), to: Math.min(to, r.to) }));
        matches.push({ from, to, text: match[0], marks: selected[0].marks, runs: selected });
      }
      text = "";
      runs = [];
    };
    block.forEach((child, offset) => {
      if (!child.isText || child.marks.some((m) => m.type.name === "del")) {
        flush();
        return;
      }
      const from = at + 1 + offset;
      runs.push({ from, to: from + child.nodeSize, marks: child.marks });
      text += child.text;
    });
    flush();
  };
  visit(node, pos);
  return matches;
}
