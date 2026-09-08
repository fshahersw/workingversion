// Plain text of a TipTap/ProseMirror JSON document, without an editor: text
// nodes joined, blocks separated by newlines. Used for the stored text
// snapshot (word counts, the assistant's document context) when content is
// produced outside the editor (imports).
import type { JsonValue } from "./types";

type Node = { type?: string; text?: string; content?: Node[] };

const INLINE = new Set(["text", "hardBreak"]);

export function docToText(doc: JsonValue): string {
  const root = doc as Node | null;
  if (!root || typeof root !== "object") return "";
  const out: string[] = [];
  const walk = (node: Node) => {
    if (node.type === "text") {
      out.push(node.text ?? "");
      return;
    }
    if (node.type === "hardBreak") {
      out.push("\n");
      return;
    }
    const children = Array.isArray(node.content) ? node.content : [];
    for (const child of children) walk(child);
    if (node.type && !INLINE.has(node.type) && node.type !== "doc") out.push("\n");
  };
  walk(root);
  return out
    .join("")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** A minimal document of plain paragraphs (the fallback when HTML conversion yields nothing). */
export function paragraphsDoc(text: string): JsonValue {
  const paragraphs = text
    .replace(/\r\n?/g, "\n")
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean);
  return {
    type: "doc",
    content: paragraphs.length
      ? paragraphs.map((p) => ({ type: "paragraph", content: [{ type: "text", text: p }] }))
      : [{ type: "paragraph" }],
  };
}
