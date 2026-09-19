import type { Node as PmNode } from "@tiptap/pm/model";
import type { Editor } from "@tiptap/core";

import {
  auditDocumentModel,
  formatDocAudit,
  type AuditBlock,
  type AuditBlockType,
  type AuditModel,
  type AuditNoteRef,
  type AuditRun,
} from "@/lib/writer/document-audit";

import { isTrackedDeleted } from "./protocol";
import type { AiDocumentAccess } from "./tools";

export { formatDocAudit };

/**
 * ProseMirror -> plain audit model. Reads marks (bold, docTextStyle.color,
 * link), docNoteRef nodes, paragraph attrs and table widths; nothing here
 * touches the DOM or a rendered image, so it is exact and instant.
 */
export function extractAuditModel(editor: Editor, app: AiDocumentAccess | undefined): AuditModel {
  const blocks: AuditBlock[] = [];
  let index = 0;
  editor.state.doc.forEach((node) => {
    blocks.push(toAuditBlock(node, index));
    index++;
  });
  const section = app?.pageSetup?.read().section ?? null;
  return {
    blocks,
    footnotes: app?.notes?.list("footnote") ?? [],
    endnotes: app?.notes?.list("endnote") ?? [],
    section: section
      ? {
          pageWidth: section.pageWidth,
          pageHeight: section.pageHeight,
          marginTop: section.marginTop,
          marginRight: section.marginRight,
          marginBottom: section.marginBottom,
          marginLeft: section.marginLeft,
        }
      : null,
  };
}

function blockType(node: PmNode): AuditBlockType {
  switch (node.type.name) {
    case "docParagraph":
      return "paragraph";
    case "docHeading":
      return "heading";
    case "docListItem":
      return "listItem";
    case "docTable":
      return "table";
    case "docProtected":
      return "protected";
    default:
      return "other";
  }
}

function toAuditBlock(node: PmNode, index: number): AuditBlock {
  const runs: AuditRun[] = [];
  const noteRefs: AuditNoteRef[] = [];
  node.descendants((child) => {
    if (child.type.name === "docNoteRef") {
      const kind = child.attrs.kind === "endnote" ? "endnote" : "footnote";
      const num = Number(child.attrs.num);
      noteRefs.push({ kind, id: String(child.attrs.id ?? ""), num: Number.isFinite(num) ? num : null });
      return false;
    }
    if (!child.isText) return true;
    // tracked deletions are struck text, not current content
    if (child.marks.some((m) => m.type.name === "del")) return true;
    const style = child.marks.find((m) => m.type.name === "docTextStyle")?.attrs as Record<string, unknown> | undefined;
    const color = typeof style?.["color"] === "string" && style["color"] ? String(style["color"]).replace(/^#/, "") : null;
    runs.push({
      text: child.text ?? "",
      bold: child.marks.some((m) => m.type.name === "bold"),
      color,
      link: child.marks.some((m) => m.type.name === "link"),
    });
    return true;
  });
  const type = blockType(node);
  const block: AuditBlock = {
    index,
    type,
    text: type === "protected" ? String(node.attrs["previewText"] ?? "") : node.textContent,
    runs,
    align: typeof node.attrs["align"] === "string" ? (node.attrs["align"] as string) : null,
    indentLeft: typeof node.attrs["indentLeft"] === "number" ? (node.attrs["indentLeft"] as number) : null,
    pageBreakBefore: node.attrs["pageBreakBefore"] === true,
    noteRefs,
    deleted: isTrackedDeleted(node),
  };
  if (type === "heading") block.level = Math.min(Math.max(Number(node.attrs["level"]) || 1, 1), 6);
  if (type === "table") {
    block.tableWidthPx = typeof node.attrs["widthPx"] === "number" ? (node.attrs["widthPx"] as number) : null;
    block.tableWidthPct = typeof node.attrs["widthPct"] === "number" ? (node.attrs["widthPct"] as number) : null;
  }
  return block;
}

/** Run the audit against the live document. */
export function auditLiveDocument(editor: Editor, app: AiDocumentAccess | undefined): string[] {
  return auditDocumentModel(extractAuditModel(editor, app));
}
