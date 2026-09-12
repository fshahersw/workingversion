import type { Node } from "@tiptap/pm/model";
import { findTextMatches } from "./text-matches.ts";

const revisions = new WeakMap<Node, number>();
let sequence = 0;
export function documentRevision(doc: Node): number {
  if (!revisions.has(doc)) revisions.set(doc, ++sequence);
  return revisions.get(doc)!;
}
const integer = (value: unknown, fallback: number) =>
  Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : fallback;

export function navigateDocument(doc: Node, input: Record<string, unknown>, search = false) {
  const revision = documentRevision(doc);
  if (input.revision !== undefined && input.revision !== revision)
    throw new Error(
      "Document changed. Restart the scan with the current revision; old indexes are no longer reliable.",
    );
  const start = integer(input.offset, 0);
  const limit = Math.min(60, Math.max(1, integer(input.limit, 40)));
  const entries: Array<Record<string, unknown>> = [];
  if (search && (typeof input.query !== "string" || !input.query || input.query.length > 1000))
    throw new Error("Provide a literal query of 1–1000 characters.");
  let index = 0;
  doc.forEach((block, pos) => {
    if (search) {
      for (const match of findTextMatches(
        block,
        pos,
        String(input.query),
        input.matchCase === true,
      )) {
        entries.push({
          blockIndex: index,
          from: match.from,
          to: match.to,
          text: match.text,
          excerpt: doc
            .textBetween(
              Math.max(pos + 1, match.from - 100),
              Math.min(pos + block.nodeSize - 1, match.to + 160),
              " ",
            )
            .slice(0, 1200),
        });
      }
    } else {
      entries.push({
        blockIndex: index,
        type: block.type.name,
        level: block.attrs.level ?? undefined,
        trackedDeletion: block.attrs.blockRevision?.kind === "del",
        protected: block.type.name === "docProtected",
        characters: block.textContent.length,
        preview: (block.textContent || String(block.attrs.previewText ?? ""))
          .replace(/\s+/g, " ")
          .slice(0, 240),
      });
    }
    index++;
  });
  if (start > entries.length) throw new Error("Offset is beyond the results. Restart at offset 0.");
  const results = entries.slice(start, start + limit);
  const nextOffset = start + results.length < entries.length ? start + results.length : null;
  return {
    revision,
    totalBlocks: doc.childCount,
    totalResults: entries.length,
    offset: start,
    nextOffset,
    results,
    coverage: search
      ? "Literal scan of all editable text blocks and table cells; excludes tracked deletions, protected objects and text in images. Not a semantic or OCR review."
      : "Structure previews only. Use read_blocks for complete content; follow every nextOffset with this revision to enumerate all blocks.",
  };
}
