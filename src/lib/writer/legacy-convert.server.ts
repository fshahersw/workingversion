// ============================================================================
// One-time conversion of legacy Drafts (TipTap/ProseMirror JSON) into a DOCX
// so they open in the Writer. Covers the node set the old editor produced:
// headings, paragraphs, lists, block quotes, tables, rules, and the inline
// marks (bold, italic, underline, strike, highlight, link). Anything unknown
// degrades to its text. Server-only; uses the `docx` package.
// ============================================================================
import {
  AlignmentType,
  Document,
  ExternalHyperlink,
  HeadingLevel,
  Packer,
  Paragraph,
  Table,
  TableCell,
  TableRow,
  TextRun,
  WidthType,
  type IParagraphOptions,
  type ParagraphChild,
} from "docx";

type PmNode = {
  type?: string;
  attrs?: Record<string, unknown>;
  content?: PmNode[];
  text?: string;
  marks?: Array<{ type?: string; attrs?: Record<string, unknown> }>;
};

const HEADINGS = [
  HeadingLevel.HEADING_1,
  HeadingLevel.HEADING_2,
  HeadingLevel.HEADING_3,
  HeadingLevel.HEADING_4,
  HeadingLevel.HEADING_5,
  HeadingLevel.HEADING_6,
] as const;

function alignmentOf(attrs?: Record<string, unknown>): IParagraphOptions["alignment"] {
  switch (attrs?.["textAlign"]) {
    case "center":
      return AlignmentType.CENTER;
    case "right":
      return AlignmentType.RIGHT;
    case "justify":
      return AlignmentType.JUSTIFIED;
    default:
      return undefined;
  }
}

function inline(node: PmNode): ParagraphChild[] {
  if (node.type === "hardBreak") return [new TextRun({ break: 1 })];
  if (node.type === "text" || node.text !== undefined) {
    const marks = new Set((node.marks ?? []).map((m) => m.type));
    const link = (node.marks ?? []).find((m) => m.type === "link");
    const run = new TextRun({
      text: node.text ?? "",
      bold: marks.has("bold") || undefined,
      italics: marks.has("italic") || undefined,
      underline: marks.has("underline") || link ? {} : undefined,
      strike: marks.has("strike") || undefined,
      highlight: marks.has("highlight") ? "yellow" : undefined,
      style: link ? "Hyperlink" : undefined,
    });
    const href = typeof link?.attrs?.["href"] === "string" ? link.attrs["href"] : "";
    return href ? [new ExternalHyperlink({ children: [run], link: href })] : [run];
  }
  return (node.content ?? []).flatMap(inline);
}

function paragraph(node: PmNode, extra: Partial<IParagraphOptions> = {}): Paragraph {
  return new Paragraph({
    children: inline({ content: node.content ?? [] }),
    alignment: alignmentOf(node.attrs),
    ...extra,
  });
}

type Block = Paragraph | Table;

type Ctx = { list?: "bullet" | "numbered"; level: number; quote?: boolean };

function blocks(node: PmNode, ctx: Ctx): Block[] {
  switch (node.type) {
    case "doc":
      return (node.content ?? []).flatMap((c) => blocks(c, ctx));
    case "heading": {
      const level = Math.min(6, Math.max(1, Number(node.attrs?.["level"]) || 1));
      return [paragraph(node, { heading: HEADINGS[level - 1] })];
    }
    case "paragraph":
      return [
        paragraph(node, {
          ...(ctx.list === "bullet" ? { bullet: { level: ctx.level } } : {}),
          ...(ctx.list === "numbered"
            ? { numbering: { reference: "legacy-numbers", level: ctx.level } }
            : {}),
          ...(ctx.quote ? { indent: { left: 720 } } : {}),
        }),
      ];
    case "bulletList":
      return (node.content ?? []).flatMap((c) => blocks(c, { list: "bullet", level: ctx.level }));
    case "orderedList":
      return (node.content ?? []).flatMap((c) => blocks(c, { list: "numbered", level: ctx.level }));
    case "listItem":
      return (node.content ?? []).flatMap((c, i) => {
        const nested = c.type === "bulletList" || c.type === "orderedList";
        // Only the first paragraph carries the marker; nested lists indent one level.
        const next: Ctx = {
          level: nested ? ctx.level + 1 : ctx.level,
          ...(i === 0 || nested ? { list: ctx.list } : {}),
          ...(ctx.quote ? { quote: true } : {}),
        };
        return blocks(c, next);
      });
    case "blockquote":
      return (node.content ?? []).flatMap((c) => blocks(c, { level: ctx.level, quote: true }));
    case "codeBlock":
      return [
        new Paragraph({
          children: [new TextRun({ text: textOf(node), font: "Courier New" })],
        }),
      ];
    case "horizontalRule":
      return [
        new Paragraph({
          children: [],
          border: { bottom: { style: "single", size: 6, color: "999999", space: 1 } },
        }),
      ];
    case "table": {
      const rows = (node.content ?? []).filter((r) => r.type === "tableRow");
      if (!rows.length) return [];
      return [
        new Table({
          width: { size: 100, type: WidthType.PERCENTAGE },
          rows: rows.map(
            (r) =>
              new TableRow({
                tableHeader: (r.content ?? []).every((c) => c.type === "tableHeader") || undefined,
                children: (r.content ?? []).map(
                  (cell) =>
                    new TableCell({
                      children: (cell.content ?? [])
                        .flatMap((c) => blocks(c, { level: 0 }))
                        .map((b) => (b instanceof Paragraph ? b : new Paragraph({ text: "" }))),
                    }),
                ),
              }),
          ),
        }),
      ];
    }
    default:
      if (node.content?.length) return (node.content ?? []).flatMap((c) => blocks(c, ctx));
      if (node.text) return [new Paragraph({ children: inline(node) })];
      return [];
  }
}

function textOf(node: PmNode): string {
  if (node.text !== undefined) return node.text;
  return (node.content ?? []).map(textOf).join(node.type === "paragraph" ? "\n" : "");
}

/** Build DOCX bytes from a TipTap JSON document (or a plain-text fallback). */
export async function legacyDraftToDocx(
  title: string,
  doc: unknown,
  fallbackText: string,
): Promise<Uint8Array> {
  let children: Block[] = [];
  if (doc && typeof doc === "object" && !Array.isArray(doc)) {
    try {
      children = blocks(doc as PmNode, { level: 0 });
    } catch {
      children = [];
    }
  }
  if (!children.length) {
    children = (fallbackText || "")
      .split(/\n{2,}|\r\n\r\n/)
      .map((p) => p.trim())
      .filter(Boolean)
      .map((p) => new Paragraph({ children: [new TextRun(p)] }));
  }
  if (!children.length) children = [new Paragraph({ children: [] })];
  const document = new Document({
    title,
    creator: "Seeger Weiss",
    numbering: {
      config: [
        {
          reference: "legacy-numbers",
          levels: [0, 1, 2].map((level) => ({
            level,
            format: "decimal" as const,
            text: `%${level + 1}.`,
            alignment: AlignmentType.START,
            style: { paragraph: { indent: { left: 720 * (level + 1), hanging: 360 } } },
          })),
        },
      ],
    },
    sections: [{ children }],
  });
  const buffer = await Packer.toBuffer(document);
  return new Uint8Array(buffer);
}
