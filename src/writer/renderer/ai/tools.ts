import { navigateDocument } from "@/lib/writer/document-navigation";
import { findTextMatches } from "@/lib/writer/text-matches";
import {
  PAPER_TWIPS,
  TWIPS_PER_INCH,
  TWIPS_PER_POINT,
  applyPageSetupPatch,
  twipsToInches,
  type PageSetupPatch,
} from "@/lib/writer/page-setup";
import { checkBluebook } from "@/lib/legal/bluebook";
import { describeCourtStyle, findCourtStyle, listCourtStyles } from "@/lib/legal/court-styles";
import type { Editor } from "@tiptap/core";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import type {
  ChartDisplay,
  CommentInfo,
  NewChart,
  SectionSettings,
  TableCell,
} from "@genoffice/docx-engine";
import { TABLE_HEADER_FILL } from "@genoffice/docx-engine";
import { tableModelToPmNode } from "../editor/convert";
import type { Command as PmCommand } from "@tiptap/pm/state";
import {
  CellSelection,
  TableMap,
  addColumnAfter,
  addColumnBefore,
  addRowAfter,
  addRowBefore,
  deleteColumn,
  deleteRow,
  mergeCells,
} from "@tiptap/pm/tables";
import { applyTablePreset, setTableAutoFit } from "../editor/table-properties";
import type { AgentToolCall, AgentToolDef, CreateDocumentType } from "../../shared/ipc";
import type { AgentImage, ToolDisplay } from "@genoffice/agent-core";
import { createPlatformSkill } from "@/office/shared/platform-skill";
import { captureElement } from "@/office/shared/capture";
import { getPlatformImage, isPlatformImage } from "@/office/shared/image-store";
import { t } from "../i18n/locale";
import { FIRM_PALETTE } from "../../shared/design";
import { executeCommands, type Command, type CommandEnvelope } from "./commands";
import {
  blockRangePositions,
  buildCommentsContext,
  buildDocumentContext,
  buildRevisionsContext,
  insertBlocksAfter,
  isBlankDocument,
  isTrackedDeleted,
  parseHtmlFragment,
  replaceBlockRange,
  serializeRangeToHtml,
  type AiHfState,
  type AiTrack,
  type NumIds,
  type SelectionScope,
} from "./protocol";

/**
 * Local agent tools: a document-context reader plus a script-style execution
 * channel. The "execution backend" is the in-process ProseMirror doc, split
 * into three safe primitives plus the deterministic command engine.
 */

const READ_MAX_CHARS = 120_000;

export const AGENT_TOOLS: AgentToolDef[] = [
  ...["read_document_outline", "search_document"].map(
    (name): AgentToolDef => ({
      name,
      readOnly: true,
      description:
        name === "search_document"
          ? "Search ALL editable document blocks and table cells for literal text across formatting. Returns exact spans, excerpts, counts and paginated results. Excludes deleted/protected content. Follow nextOffset with the same revision. Read surrounding blocks before substantive edits; a literal scan is not full semantic review."
          : "Enumerate the complete document outline, including the middle of long files. Follow nextOffset with the same revision until null. Previews are not full content; use read_blocks on relevant ranges. Never infer missing indexes.",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "Literal text to find (search_document only)" },
          matchCase: { type: "boolean" },
          offset: { type: "integer" },
          limit: { type: "integer", description: "1�60 entries" },
          revision: {
            type: "integer",
            description: "Revision from the previous page; rejected if the document changed",
          },
        },
        required: name === "search_document" ? ["query"] : [],
      },
    }),
  ),
  {
    name: "view_page",
    readOnly: true,
    description:
      "Capture a rendering of the document as it looks on screen (PNG) so you can check layout, fonts, tables, alignment and spacing visually. Optionally limit the capture to a block range; without a range the capture starts at the top of the document. Use after formatting edits to verify the result, or when the user asks about how something looks. The image is attached to the result.",
    inputSchema: {
      type: "object",
      properties: {
        startBlockIndex: { type: "integer", description: "first block to include (0-based)" },
        endBlockIndex: { type: "integer", description: "last block to include (inclusive)" },
        scale: { type: "number", description: "render scale 0.5-2, default 1.25" },
      },
      required: [],
    },
  },
  {
    name: "get_document_context",
    readOnly: true,
    description:
      "Get the latest state of the current document: block list (index|type|content preview), full-text stats (word/character counts) and the current selection. Block indexes change after modifications; call this when you need up-to-date indexes.",
    inputSchema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "read_blocks",
    readOnly: true,
    description:
      "Read the full content of a block range (restricted HTML). Previews in the block list are truncated; you must read the full original text with this tool before rewriting. " +
      "Long ranges are paged: a truncated result says which offset to continue from; concatenate the slices in order to get the full HTML.",
    inputSchema: {
      type: "object",
      properties: {
        startBlockIndex: { type: "integer", description: "start block index (0-based, inclusive)" },
        endBlockIndex: { type: "integer", description: "end block index (inclusive)" },
        offset: {
          type: "integer",
          description:
            "character offset to continue a truncated read (default 0); use the offset given in the previous truncation notice",
        },
      },
      required: ["startBlockIndex", "endBlockIndex"],
    },
  },
  {
    name: "insert_content",
    description:
      "Insert new content at a given position (restricted HTML, may contain multiple blocks). For writing/continuing/generating new content; to rewrite existing content use replace_blocks.",
    inputSchema: {
      type: "object",
      properties: {
        html: { type: "string", description: "restricted HTML fragment to insert" },
        afterBlockIndex: {
          type: "integer",
          description:
            "insert after this block index; -1 = start of document; omitted = after the block containing the cursor",
        },
      },
      required: ["html"],
    },
  },
  {
    name: "replace_blocks",
    description:
      "Replace a block range with new content (restricted HTML). For rewriting/translating/condensing/expanding existing content; the new block count may differ from the old. New blocks inherit the replaced blocks' paragraph and text formatting (font, size, color, indent, spacing, alignment) automatically, and a rewritten <table> keeps the old table's column widths, borders, shading and cell formatting (unchanged cells keep their content); never try to restore formatting afterwards.",
    inputSchema: {
      type: "object",
      properties: {
        startBlockIndex: { type: "integer", description: "start block index (0-based, inclusive)" },
        endBlockIndex: { type: "integer", description: "end block index (inclusive)" },
        html: { type: "string", description: "replacement restricted HTML fragment" },
      },
      required: ["startBlockIndex", "endBlockIndex", "html"],
    },
  },
  {
    name: "apply_commands",
    description:
      "Execute formatting/structure/batch commands (batchUpdate style, see the command guide in the system prompt): text style (whole-block or matched-text-only), paragraph format, heading level, find & replace, delete/move blocks, list conversion, image properties, TOC insertion.",
    inputSchema: {
      type: "object",
      properties: {
        commands: {
          type: "array",
          description: "array of commands executed in order; each command is a single-key object",
          items: { type: "object" },
        },
      },
      required: ["commands"],
    },
  },
  {
    name: "read_revisions",
    readOnly: true,
    description:
      "List every pending tracked revision (insertions, deletions, formatting/move/table changes) with kind, author, date, block index and the affected text. Read-only: revisions are accepted/rejected by the user in the Review tab.",
    inputSchema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "read_comments",
    readOnly: true,
    description:
      "List all comment threads (including resolved ones) with ids, authors, anchored block indexes and anchor text. Unresolved threads already ride along in the message context; use this for the full picture.",
    inputSchema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "reply_comment",
    description:
      "Add a reply to a comment thread: after completing a requested change (summarize what changed), or to answer/ask back when the comment is a question or is ambiguous.",
    inputSchema: {
      type: "object",
      properties: {
        parentId: { type: "string", description: "id of the comment thread to reply to" },
        text: { type: "string", description: "reply text" },
      },
      required: ["parentId", "text"],
    },
  },
  {
    name: "resolve_comment",
    description:
      "Mark a comment thread as resolved. Only after the requested change was applied (reply first), or when the user explicitly asked to resolve.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "id of the comment thread to resolve" },
      },
      required: ["id"],
    },
  },
  {
    name: "web_search",
    readOnly: true,
    description:
      "Search the web for textual information (references/data/facts). Use when you need up-to-date information or are unsure about a fact. Returns titles/links/snippets.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "search keywords" },
        maxResults: { type: "integer", description: "maximum number of results, default 6" },
      },
      required: ["query"],
    },
  },
  {
    name: "image_search",
    readOnly: true,
    description:
      "Search for images. Returns a list of image imageUrl entries; after picking one, insert it into the document with insert_image.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "image search keywords (English works better)" },
        maxResults: { type: "integer", description: "maximum number of results, default 8" },
      },
      required: ["query"],
    },
  },
  {
    name: "insert_image",
    description:
      "Insert an image into the document (at the cursor / end of document): a platform-image:<id> handle returned by render_diagram, generate_image or run_python, or a direct image link.",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "platform-image:<id> handle or a direct image link" },
        maxWidthPx: { type: "integer", description: "maximum width (px), default 480" },
      },
      required: ["url"],
    },
  },
  {
    name: "generate_image",
    description:
      "Generate an illustration with Amazon Nova Canvas from a text prompt and insert it into the document (at the cursor / end of document): cover art, icons, abstract backgrounds, illustrations. Not for real people or trademarks; for diagrams use render_diagram.",
    inputSchema: {
      type: "object",
      properties: {
        prompt: {
          type: "string",
          description:
            "detailed English description of the image to generate (subject, style, composition, palette)",
        },
        aspectRatio: {
          type: "string",
          enum: ["1:1", "16:9", "9:16", "4:3", "3:4", "3:2", "2:3"],
          description: "default 1:1",
        },
        negativePrompt: {
          type: "string",
          description: "what to avoid (text, watermarks, clutter)",
        },
        maxWidthPx: { type: "integer", description: "maximum width (px), default 480" },
      },
      required: ["prompt"],
    },
  },
  {
    name: "insert_chart",
    description:
      "Insert a chart (saved as a native Word chart). Data must be real: from the document content or web_search results — do not make up numbers.",
    inputSchema: {
      type: "object",
      properties: {
        kind: { type: "string", enum: ["bar", "line", "pie"], description: "chart type" },
        title: { type: "string", description: "chart title" },
        categories: {
          type: "array",
          items: { type: "string" },
          description: "category (x axis / sector) labels",
        },
        series: {
          type: "array",
          description:
            "data series; values has the same length as categories, use null for missing data. Pie charts use only the first series",
          items: {
            type: "object",
            properties: {
              name: { type: "string" },
              values: { type: "array", items: { type: ["number", "null"] } },
            },
            required: ["values"],
          },
        },
        afterBlockIndex: {
          type: "integer",
          description:
            "insert after this block index; -1 = start of document; omitted = after the block containing the cursor",
        },
      },
      required: ["kind", "categories", "series"],
    },
  },
  {
    name: "edit_chart",
    description:
      "Edit the data of an existing chart in the document (title/category labels/series names/values). Chart blocks in the block list can be edited; " +
      "the category count and the number of values per series must match the original chart (data points cannot be added or removed).",
    inputSchema: {
      type: "object",
      properties: {
        blockIndex: { type: "integer", description: "block index of the chart" },
        title: { type: "string", description: "new title (omit to keep)" },
        categories: {
          type: "array",
          items: { type: ["string", "null"] },
          description:
            "new category labels, same length as the original; pass null for positions to keep",
        },
        series: {
          type: "array",
          description: "series to change",
          items: {
            type: "object",
            properties: {
              index: { type: "integer", description: "series index (0-based)" },
              name: { type: "string", description: "new series name (omit to keep)" },
              values: {
                type: "array",
                items: { type: ["number", "null"] },
                description:
                  "new values, same length as the original series; pass null for positions to keep",
              },
            },
            required: ["index"],
          },
        },
      },
      required: ["blockIndex"],
    },
  },
  {
    name: "insert_table",
    description:
      "Insert a native table with an optional header row, body rows, optional relative column widths and a firm style preset. Cells hold plain text (use \\n for line breaks). Prefer this over an HTML <table> whenever you want column widths or a banded / header style.",
    inputSchema: {
      type: "object",
      properties: {
        headers: {
          type: "array",
          items: { type: "string" },
          description:
            "header (first) row cell texts; omit or pass [] for a table with no header row",
        },
        rows: {
          type: "array",
          items: { type: "array", items: { type: "string" } },
          description: "body rows, each an array of plain-text cell values",
        },
        colWidths: {
          type: "array",
          items: { type: "number" },
          description:
            "optional relative column widths (any units; normalized to percentages); length must equal the column count",
        },
        stylePreset: {
          type: "string",
          enum: [
            "firmNavy",
            "firmBlue",
            "firmAccent",
            "firmMinimal",
            "none",
            "lightGrid",
            "zebraBlue",
            "zebraGray",
            "headerDarkBlue",
            "headerOrange",
            "noBorder",
            "fullBorder",
          ],
          description:
            "visual style; default firmNavy (navy header, white bold header text, soft navy bands). firmBlue for schedules/chronologies, firmAccent for one spotlight table, firmMinimal (no fills, light rules) for court filings and dense financials",
        },
        afterBlockIndex: {
          type: "integer",
          description:
            "insert after this block index; -1 = start of document; omitted = after the block containing the cursor",
        },
      },
      required: ["rows"],
    },
  },
  {
    name: "insert_page_break",
    description:
      "Start a new page at a block boundary. beforeBlockIndex is the block that must begin the new page (use indexes from the document block list); the break is stored as a native Word page break on that block, or as an empty break paragraph when the block is a table or image. beforeBlockIndex equal to the block count appends a new empty page at the end. remove:true clears an existing break before that block instead. Use this for cover pages, tables of contents, exhibits, appendices and signature pages rather than blank lines.",
    inputSchema: {
      type: "object",
      properties: {
        beforeBlockIndex: {
          type: "integer",
          description:
            "0-based index of the block that should start the new page; omitted = the block after the cursor",
        },
        remove: {
          type: "boolean",
          description: "true removes the page break before that block instead of adding one",
        },
      },
    },
  },
  {
    name: "edit_table",
    description:
      "Edit an existing table (addressed by its block index): set cell text, add or delete a row or column, and/or restyle it. Apply at most one row/column add-or-delete per call (indexes shift after a structural change). Cells hold plain text. After a structural change, call get_document_context before editing the same table again.",
    inputSchema: {
      type: "object",
      properties: {
        blockIndex: {
          type: "integer",
          description: 'block index of the target table (type "table" in the block list)',
        },
        setCells: {
          type: "array",
          description: "cells to overwrite with new plain text",
          items: {
            type: "object",
            properties: {
              row: { type: "integer", description: "0-based row (header row = 0)" },
              col: { type: "integer", description: "0-based column" },
              text: { type: "string" },
            },
            required: ["row", "col", "text"],
          },
        },
        addRow: {
          type: "object",
          description: "insert a row relative to an existing 0-based row",
          properties: {
            at: { type: "integer" },
            position: { type: "string", enum: ["before", "after"] },
          },
          required: ["at"],
        },
        addColumn: {
          type: "object",
          description: "insert a column relative to an existing 0-based column",
          properties: {
            at: { type: "integer" },
            position: { type: "string", enum: ["before", "after"] },
          },
          required: ["at"],
        },
        deleteRow: { type: "integer", description: "0-based row index to delete" },
        deleteColumn: { type: "integer", description: "0-based column index to delete" },
        restyle: {
          type: "string",
          enum: [
            "firmNavy",
            "firmBlue",
            "firmAccent",
            "firmMinimal",
            "none",
            "lightGrid",
            "zebraBlue",
            "zebraGray",
            "headerDarkBlue",
            "headerOrange",
            "noBorder",
            "fullBorder",
          ],
          description: "apply a style preset to the whole table",
        },
      },
      required: ["blockIndex"],
    },
  },
  {
    name: "set_header_footer",
    description:
      "Set the page header or footer text (the current contents are listed in the message context). Plain text; \\n separates lines; the tokens {PAGE} and {NUMPAGES} become live page-number fields; an empty string clears the text. " +
      'Per-line alignment/styling of the existing header/footer is preserved; images in it are untouched. view "first"/"even" writes the different-first-page / even-page variant (enabling that setting if needed).',
    inputSchema: {
      type: "object",
      properties: {
        kind: { type: "string", enum: ["header", "footer"] },
        text: {
          type: "string",
          description: 'new text; \\n between lines; may contain {PAGE} / {NUMPAGES}; "" clears',
        },
        view: {
          type: "string",
          enum: ["default", "first", "even"],
          description: "which variant to write (default when omitted)",
        },
      },
      required: ["kind", "text"],
    },
  },
  {
    name: "set_page_setup",
    description:
      "Page layout for the cursor's section or every section: orientation (portrait/landscape), paper size (letter/legal/a4), margins in inches, and the number of text columns. Only the fields given change; a call with no fields reports the current layout without changing anything. Use applyTo 'all' for a whole-document change (the usual case for a filing); 'current' for one section, e.g. a landscape exhibit or schedule section that was already split off with a section break.",
    inputSchema: {
      type: "object",
      properties: {
        orientation: { type: "string", enum: ["portrait", "landscape"] },
        paperSize: { type: "string", enum: ["letter", "legal", "a4"] },
        margins: {
          type: "object",
          description: "margins in inches; give only the sides to change (0.5–2.0)",
          properties: {
            top: { type: "number" },
            right: { type: "number" },
            bottom: { type: "number" },
            left: { type: "number" },
          },
        },
        columns: { type: "integer", description: "number of text columns, 1–3" },
        applyTo: {
          type: "string",
          enum: ["current", "all"],
          description: "which sections to change (default 'current')",
        },
      },
    },
  },
  {
    name: "set_table_properties",
    description:
      "Table-level layout for an existing table (by block index), the properties Word keeps under Table Properties: repeatHeaderRows (the first row — or headerRowCount rows — repeats at the top of every page the table spans; essential for long schedules, privilege logs, exhibit lists), alignment (left/center/right), widthPercent of the text width, autoFit (contents/window/fixed), a border scheme (all/outside/horizontal/headerRule/none) with an optional hex borderColor, cellPadding in points, and mergeCells (a rectangular range merged into one cell; only one merge per call). Cell TEXT and row/column add/delete are edit_table; visual fill presets are edit_table restyle. Only the fields given change.",
    inputSchema: {
      type: "object",
      properties: {
        blockIndex: {
          type: "integer",
          description: 'block index of the target table (type "table" in the block list)',
        },
        repeatHeaderRows: {
          type: "boolean",
          description: "true = header row(s) repeat on each page; false = stop repeating",
        },
        headerRowCount: {
          type: "integer",
          description: "how many leading rows form the header (default 1; used with repeatHeaderRows)",
        },
        alignment: { type: "string", enum: ["left", "center", "right"] },
        widthPercent: {
          type: "number",
          description: "preferred table width as a percentage of the text width (10–100)",
        },
        autoFit: { type: "string", enum: ["contents", "window", "fixed"] },
        borders: {
          type: "string",
          enum: ["all", "outside", "horizontal", "headerRule", "none"],
          description:
            "all = full grid; outside = box only; horizontal = rules between rows only; headerRule = a rule under the header and under the last row only (court-filing style); none = no borders",
        },
        borderColor: {
          type: "string",
          description: "6-digit hex without '#' for the border scheme (default 000000)",
        },
        borderWidthPt: {
          type: "number",
          description: "border line width in points (0.25–3; default 0.5)",
        },
        cellPadding: {
          type: "object",
          description: "cell margins in points; give only the sides to change",
          properties: {
            top: { type: "number" },
            right: { type: "number" },
            bottom: { type: "number" },
            left: { type: "number" },
          },
        },
        mergeCells: {
          type: "object",
          description: "merge the rectangle from (fromRow, fromCol) to (toRow, toCol), 0-based inclusive",
          properties: {
            fromRow: { type: "integer" },
            fromCol: { type: "integer" },
            toRow: { type: "integer" },
            toCol: { type: "integer" },
          },
          required: ["fromRow", "fromCol", "toRow", "toCol"],
        },
      },
      required: ["blockIndex"],
    },
  },
  {
    name: "insert_footnote",
    description:
      "Insert a footnote (or endnote) whose reference mark sits immediately after a piece of body text. afterText is a literal phrase in the document (usually the end of the sentence the note supports, including its closing punctuation — Bluebook puts the reference after the period); blockIndex narrows the search to one block when the phrase occurs more than once; occurrence picks the Nth match (1-based). text is the note body (plain text; cite in Bluebook form). Returns the note number.",
    inputSchema: {
      type: "object",
      properties: {
        afterText: { type: "string", description: "literal document text the reference follows" },
        text: { type: "string", description: "the note text" },
        blockIndex: { type: "integer", description: "restrict the search to this block" },
        occurrence: { type: "integer", description: "which match to use when several (default 1)" },
        matchCase: { type: "boolean", description: "default true" },
        kind: { type: "string", enum: ["footnote", "endnote"], description: "default footnote" },
      },
      required: ["afterText", "text"],
    },
  },
  {
    name: "check_bluebook_citations",
    readOnly: true,
    description:
      "Deterministic Bluebook FORM check of the document text (or of blockIndexes / the given text): reporter abbreviations and spacing (F.3d, F. Supp. 3d, S. Ct.), 2d/3d ordinals, court-and-year parentheticals (circuit for F.3d/F.4th, district for F. Supp.), full dates for WL/LEXIS cites, T12 month abbreviations, Id./Ibid. short forms, See, e.g., signals, 'at p.' pinpoints, § spacing, U.S.C./C.F.R./Fed. R. Civ. P. abbreviations. Each finding has the rule, the exact text found, and where mechanical a drop-in suggestion plus its occurrence count — apply those with apply_commands replaceAllText (set expectedOccurrences to the count). It checks form only; use verify_citations to confirm a case exists and read the source before relying on it. It does not judge case-name italics or proposition support.",
    inputSchema: {
      type: "object",
      properties: {
        blockIndexes: {
          type: "array",
          items: { type: "integer" },
          description: "check only these blocks (default: whole document)",
        },
        text: { type: "string", description: "check this text instead of the document" },
        maxFindings: { type: "integer", description: "cap on findings returned (default 60)" },
      },
    },
  },
  {
    name: "apply_court_style",
    description:
      "Apply a court's brief-formatting rule to the whole document — typeface, body size, line spacing and page margins — from a rule-cited profile (frap = U.S. Courts of Appeals FRAP 32; scotus-booklet / scotus-8x11 = Supreme Court Rule 33; sdny-edny = S.D.N.Y./E.D.N.Y. Local Civil Rule 11.1; cal-superior = California Rules of Court 2.104–2.108; conservative-default = 12-pt serif, double-spaced, 1-inch margins), or from explicit custom values. Headings keep single spacing; footnote text size is reported, not changed. dryRun true returns the profile's requirements without changing anything. The profile text ends with a verification note — always relay it: local rules and judges' standing orders change.",
    inputSchema: {
      type: "object",
      properties: {
        court: {
          type: "string",
          description: "profile id: frap | scotus-booklet | scotus-8x11 | sdny-edny | cal-superior | conservative-default",
        },
        custom: {
          type: "object",
          description: "explicit values instead of (or overriding) the profile",
          properties: {
            fontFamily: { type: "string" },
            bodySizePt: { type: "number" },
            lineSpacing: { type: "number", description: "1, 1.5 or 2" },
            marginsIn: {
              type: "object",
              properties: {
                top: { type: "number" },
                right: { type: "number" },
                bottom: { type: "number" },
                left: { type: "number" },
              },
            },
          },
        },
        dryRun: { type: "boolean", description: "report the requirements only" },
      },
    },
  },
  {
    name: "create_document",
    description:
      "Create a NEW separate document in the Library and return a link to open it; the current document is not modified. Use when the user asks to put content into a new/separate document (a memo from these notes, a deck summarizing this brief). " +
      "type 'docx' (default, opens in the Writer), 'pptx' (opens in Slides; each heading becomes a slide, list items become bullets) or 'pdf' (downloaded) take the same restricted HTML as insert_content in content; type 'md' takes Markdown source and produces a Word document. Images and charts are not carried into the new file.",
    inputSchema: {
      type: "object",
      properties: {
        type: {
          type: "string",
          enum: ["docx", "pptx", "pdf", "md"],
          description: "target file type (default 'docx')",
        },
        title: { type: "string", description: "document title, used as the file name" },
        content: {
          type: "string",
          description: "full document content: restricted HTML for docx/pptx/pdf, Markdown for md",
        },
      },
      required: ["title", "content"],
    },
  },
];

// Platform build: shared server-side and browser-side tools (Python sandbox,
// Graphviz/Mermaid diagrams, citation verification, page reading, firm guides,
// clarification card). generate_image and create_document keep the Writer's own
// definitions above and are routed to the platform in executeAsyncTool.
/** Editor the current tool call targets; set by executeTool before platform tools run. */
let activeEditor: Editor | null = null;
let activeNumIds: NumIds | null = null;
let activeTrack: AiTrack | undefined;

const officeTaskScopes = new WeakMap<Editor, string>();
export function beginOfficeTask(editor: Editor) {
  officeTaskScopes.set(editor, crypto.randomUUID());
}
const taskForEditor = (editor: Editor) => {
  if (!officeTaskScopes.has(editor)) beginOfficeTask(editor);
  return officeTaskScopes.get(editor)!;
};
const platformSkill = createPlatformSkill({
  taskScope: () => taskForEditor(activeEditor!),
  app: "writer",
  exclude: ["generate_image", "create_document"],
  templates: {
    apply: async (payload, template, input) => {
      const editor = activeEditor;
      if (!editor) return fail(t("aiSumInsertContent"), "the editor is not available");
      if (payload.format !== "html")
        return fail(t("aiSumInsertContent"), "this template is not a Writer template");
      const echo = toolEchoError(payload.html);
      if (echo) return fail(t("aiSumInsertContent"), echo);
      let nodes: ReturnType<typeof parseHtmlFragment>;
      try {
        nodes = parseHtmlFragment(payload.html, activeNumIds ?? { bullet: null, ordered: null });
      } catch (e) {
        return fail(t("aiSumInsertContent"), e instanceof Error ? e.message : String(e));
      }
      if (!nodes.length)
        return fail(t("aiSumInsertContent"), "the template produced no content blocks");
      const count = editor.state.doc.childCount;
      if (input["replace"] === true || isBlankDocument(editor)) {
        replaceBlockRange(editor, 0, count - 1, nodes, activeTrack);
      } else {
        insertBlocksAfter(editor, count - 1, nodes, activeTrack);
      }
      markDocSeen(editor);
      return {
        output: `Applied template "${template.name}" (${nodes.length} blocks). Placeholders are written as [Bracketed Labels]; call get_document_context, then fill them from the user's facts with replace_blocks or apply_commands (find & replace).`,
        mutated: true,
        summary: t("aiSumInsertedBlocks", { count: nodes.length }),
      };
    },
    capture: async () => {
      const editor = activeEditor;
      if (!editor) throw new Error("the editor is not available");
      const html = serializeRangeToHtml(editor, 0, editor.state.doc.childCount - 1);
      if (!html.trim()) throw new Error("the document is empty");
      return { format: "html", html };
    },
  },
});
AGENT_TOOLS.push(...platformSkill.tools);
export const PLATFORM_SYSTEM_PROMPT = platformSkill.systemPrompt;
const PLATFORM_TOOL_NAMES = new Set(platformSkill.tools.map((tool) => tool.name));

/**
 * App-owned header/footer state, handed to the tool executor. Writes run the
 * same commit path as on-canvas editing (variant routing, per-section edits,
 * dirty flags), so the docx save path needs no changes.
 */
export interface AiHeaderFooterAccess {
  read(): AiHfState;
  /** returns an error message, or null on success */
  set(kind: "header" | "footer", view: "default" | "first" | "even", text: string): string | null;
}

/**
 * App-owned page layout (sectPr) state for the set_page_setup and
 * apply_court_style tools. Writes go through the same path as the Layout
 * ribbon (per-section settings, final-section geometry, dirty flags).
 */
export { applyPageSetupPatch, type PageSetupPatch } from "@/lib/writer/page-setup";

export interface AiPageSetupAccess {
  read(): {
    /** settings of the cursor's section (or the single section) */
    section: SectionSettings | null;
    sectionCount: number;
    /** 0-based index of the cursor's section */
    activeSection: number;
    locked: boolean;
  };
  /** returns an error message, or null on success */
  set(patch: PageSetupPatch, applyTo: "current" | "all"): string | null;
}

/**
 * App-owned footnote/endnote store for insert_footnote. The note text lives in
 * app state; the reference mark is an inline node the App inserts at `pos` so
 * numbering and the docx save path match the Insert Footnote ribbon action.
 */
export interface AiNotesAccess {
  list(kind: "footnote" | "endnote"): { id: string; text: string }[];
  /** insert a new note whose reference mark goes at document position `pos`;
   *  returns the note's number, or an error message */
  insert(kind: "footnote" | "endnote", text: string, pos: number): { num: number } | string;
}

/** Document-level app state the Writer tools may reach beyond the PM doc. */
export interface AiDocumentAccess {
  pageSetup?: AiPageSetupAccess;
  notes?: AiNotesAccess;
}

/**
 * The App-owned comments store, handed to the tool executor. Mutations run
 * the same review-actions code paths as the comments pane, so AI replies and
 * resolves behave exactly like manual ones (anchors, dirty flags, docx save).
 */
export interface AiCommentsAccess {
  list(): CommentInfo[];
  /** false when the parent thread or its anchor no longer exists */
  reply(parentId: string, text: string): boolean;
  /** false when the thread does not exist */
  resolve(id: string): boolean;
}

/**
 * Selection frozen at context build, valid only while `doc` is still the live
 * document. A user click elsewhere keeps the doc identical (selection-only
 * transaction) so the freeze holds; once any edit lands, the live selection —
 * which ProseMirror has remapped through those edits — is the correct target
 * again and the frozen block indexes would drift, so the freeze is dropped.
 */
export interface FrozenSelection {
  scope: SelectionScope;
  doc: ProseMirrorNode;
}

export interface ToolExecution {
  /** result text fed back to the model */
  output: string;
  isError?: boolean;
  /** true when the tool changed the document */
  mutated: boolean;
  /** short human-readable label for the chat activity chip */
  summary: string;
  /** UI-only side channel (image thumbnails, links); never sent to the model */
  display?: ToolDisplay;
  /** images the model should look at (captures, generated pictures) */
  images?: AgentImage[];
}

const fail = (summary: string, output: string): ToolExecution => ({
  output,
  isError: true,
  mutated: false,
  summary,
});

/**
 * A model that saw gateway-flattened tool results can regurgitate them as the
 * html argument (raw {"index":…} block dumps, literal </tool_response> tags);
 * reject those so protocol artifacts never land in the document as text.
 */
function toolEchoError(html: string): string | null {
  if (/<\/?tool_response>/i.test(html)) {
    return "html contains a literal <tool_response> tag — that is tool-protocol output, not document content; retry with the actual restricted-HTML fragment";
  }
  // the context/read dump shape is screened anywhere in the payload (fenced or
  // prose-wrapped dumps included) — it is never legitimate document content
  if (/"index"\s*:\s*\d+\s*,\s*"type"\s*:\s*"/.test(html)) {
    return "html contains a raw JSON block dump, not an HTML fragment; retry with restricted HTML (e.g. <p>…</p>)";
  }
  // unwrap only a fully fenced payload; an embedded fence inside otherwise
  // valid HTML must not shadow the real content
  let candidate = html.trim();
  const fence = /^```[a-z]*\s*([\s\S]*?)```\s*$/i.exec(candidate);
  if (fence) candidate = fence[1].trim();
  if (!/^[[{]/.test(candidate)) return null;
  try {
    JSON.parse(candidate);
    return "html is raw JSON, not an HTML fragment; retry with restricted HTML (e.g. <p>…</p>)";
  } catch {
    return null; // brace-led plain text is legitimate content
  }
}

/** Doc as last seen by the AI pipeline (context build / read / own write); a differing doc means the user edited in between. */
const docBaseline = new WeakMap<Editor, ProseMirrorNode>();

export function markDocSeen(editor: Editor): void {
  docBaseline.set(editor, editor.state.doc);
}

/** A streamed load tail is not a user edit: appending at the end keeps every block index the model saw valid. */
export function carryDocSeen(editor: Editor, before: ProseMirrorNode): void {
  if (docBaseline.get(editor) === before) docBaseline.set(editor, editor.state.doc);
}

function editedExternally(editor: Editor): boolean {
  const seen = docBaseline.get(editor);
  return seen !== undefined && seen !== editor.state.doc;
}

/** tools addressing the document by block index: refused after an external edit until the model re-reads */
const INDEX_WRITE_SUMMARIES: Record<string, () => string> = {
  insert_content: () => t("aiSumInsertContent"),
  replace_blocks: () => t("aiSumReplaceContent"),
  apply_commands: () => t("aiSumApplyCommands"),
  insert_chart: () => t("aiSumInsertChart"),
  edit_chart: () => t("aiSumEditChart"),
  insert_table: () => t("aiSumInsertContent"),
  insert_page_break: () => t("aiSumInsertContent"),
  edit_table: () => t("aiSumInsertContent"),
  set_table_properties: () => t("aiSumInsertContent"),
  insert_footnote: () => t("aiSumInsertContent"),
};

const STALE_DOC_ERROR =
  "The document was edited by the user since it was last read; block indexes may be stale. " +
  "Call get_document_context (or read_blocks) to get the current state, then retry.";

function rangeError(editor: Editor): string {
  return `block index invalid or out of range (the document has ${editor.state.doc.childCount} blocks); call get_document_context for fresh indexes`;
}

/** Self-contained table style presets (fills/text/border baked into the model at
 *  build time, so no styles.xml dependency and no post-insert selection needed).
 *  Hexes are without '#', matching TableCell.fill/color; shared naming with Slides. */
type TablePresetSpec = {
  headerFill: string | null;
  headerText: string | null;
  band1Fill: string | null;
  band2Fill: string | null;
  borderColor: string;
  border: boolean;
};
const TABLE_PRESETS: Record<string, TablePresetSpec> = {
  // Firm presets (src/writer/shared/design.ts palette). firmNavy is the default.
  firmNavy: {
    headerFill: FIRM_PALETTE.navy,
    headerText: FIRM_PALETTE.paper,
    band1Fill: FIRM_PALETTE.navyTint,
    band2Fill: FIRM_PALETTE.paper,
    borderColor: FIRM_PALETTE.rule,
    border: true,
  },
  firmBlue: {
    headerFill: FIRM_PALETTE.blue,
    headerText: FIRM_PALETTE.paper,
    band1Fill: FIRM_PALETTE.blueSoft,
    band2Fill: FIRM_PALETTE.paper,
    borderColor: FIRM_PALETTE.rule,
    border: true,
  },
  firmAccent: {
    headerFill: FIRM_PALETTE.bronze,
    headerText: FIRM_PALETTE.paper,
    band1Fill: FIRM_PALETTE.bronzeTint,
    band2Fill: FIRM_PALETTE.paper,
    borderColor: FIRM_PALETTE.rule,
    border: true,
  },
  firmMinimal: {
    headerFill: null,
    headerText: FIRM_PALETTE.navy,
    band1Fill: null,
    band2Fill: null,
    borderColor: FIRM_PALETTE.rule,
    border: true,
  },
  none: {
    headerFill: TABLE_HEADER_FILL,
    headerText: null,
    band1Fill: null,
    band2Fill: null,
    borderColor: "auto",
    border: true,
  },
  lightGrid: {
    headerFill: "F2F2F2",
    headerText: null,
    band1Fill: null,
    band2Fill: null,
    borderColor: "BFBFBF",
    border: true,
  },
  zebraBlue: {
    headerFill: "4472C4",
    headerText: "FFFFFF",
    band1Fill: "D6E4F0",
    band2Fill: "FFFFFF",
    borderColor: "C9D8EA",
    border: true,
  },
  zebraGray: {
    headerFill: "595959",
    headerText: "FFFFFF",
    band1Fill: "EDEDED",
    band2Fill: "FFFFFF",
    borderColor: "BFBFBF",
    border: true,
  },
  headerDarkBlue: {
    headerFill: "1F3864",
    headerText: "FFFFFF",
    band1Fill: "E9EDF5",
    band2Fill: "FFFFFF",
    borderColor: "D9D9D9",
    border: true,
  },
  headerOrange: {
    headerFill: "ED7D31",
    headerText: "FFFFFF",
    band1Fill: "FBE5D6",
    band2Fill: "FFFFFF",
    borderColor: "D9D9D9",
    border: true,
  },
  noBorder: {
    headerFill: "F2F2F2",
    headerText: null,
    band1Fill: "F2F2F2",
    band2Fill: null,
    borderColor: "auto",
    border: false,
  },
  fullBorder: {
    headerFill: TABLE_HEADER_FILL,
    headerText: null,
    band1Fill: null,
    band2Fill: null,
    borderColor: "000000",
    border: true,
  },
};

/** Build one table row's cells, baking the preset's fill/text/bold per row index (0 = header). */
function tableRowCells(
  cells: string[],
  cols: number,
  rowIndex: number,
  isHeader: boolean,
  p: TablePresetSpec,
): TableCell[] {
  const fill = isHeader ? p.headerFill : rowIndex % 2 === 0 ? p.band2Fill : p.band1Fill;
  const out: TableCell[] = [];
  for (let c = 0; c < cols; c++) {
    const cell: TableCell = { paras: [cells[c] ?? ""] };
    if (isHeader) cell.bold = true;
    if (fill) cell.fill = fill;
    if (isHeader && p.headerText) cell.color = p.headerText;
    out.push(cell);
  }
  return out;
}

/** Resolve a docTable block by index into its node + content start + grid map. */
function docTableAt(
  editor: Editor,
  idx: number,
): { node: ProseMirrorNode; tableStart: number; map: TableMap } | null {
  if (!Number.isInteger(idx) || idx < 0 || idx >= editor.state.doc.childCount) return null;
  const { from } = blockRangePositions(editor, idx, idx);
  const node = editor.state.doc.nodeAt(from);
  if (!node || node.type.name !== "docTable") return null;
  return { node, tableStart: from + 1, map: TableMap.get(node) };
}

/** Overwrite one cell's content with plain text (in-place; keeps load-time save signatures). */
function setTableCellText(
  editor: Editor,
  idx: number,
  row: number,
  col: number,
  text: string,
): boolean {
  const info = docTableAt(editor, idx);
  if (!info) return false;
  const { map, tableStart } = info;
  if (row < 0 || col < 0 || row >= map.height || col >= map.width) return false;
  const cellPos = tableStart + map.map[row * map.width + col]!;
  const cellNode = editor.state.doc.nodeAt(cellPos);
  if (!cellNode) return false;
  editor
    .chain()
    .setTextSelection({ from: cellPos + 1, to: cellPos + cellNode.nodeSize - 1 })
    .insertContent(text.replace(/\r?\n/g, " "))
    .run();
  return true;
}

// --- Table property helpers --------------------------------------------------

/** Patch top-level attributes of the table at block `idx` (no selection needed). */
function patchTableAttrs(editor: Editor, idx: number, patch: Record<string, unknown>): boolean {
  const info = docTableAt(editor, idx);
  if (!info) return false;
  const pos = info.tableStart - 1;
  editor.view.dispatch(
    editor.state.tr.setNodeMarkup(pos, undefined, { ...info.node.attrs, ...patch }),
  );
  return true;
}

/** Mark the first `count` rows as repeating header rows (0 = none). */
function setRepeatHeaderRows(editor: Editor, idx: number, count: number, rows: number): boolean {
  const info = docTableAt(editor, idx);
  if (!info) return false;
  let tr = editor.state.tr;
  info.node.forEach((row, offset, index) => {
    if (index >= rows) return;
    const repeat = index < count;
    if (row.attrs.repeatHeader === repeat && row.attrs.repeatHeaderEdited) return;
    tr = tr.setNodeMarkup(info.tableStart + offset, undefined, {
      ...row.attrs,
      repeatHeader: repeat,
      repeatHeaderEdited: true,
    });
  });
  if (!tr.docChanged) return true;
  editor.view.dispatch(tr);
  return true;
}

type BorderScheme = "all" | "outside" | "horizontal" | "headerRule" | "none";
const BORDER_SCHEMES = new Set<string>(["all", "outside", "horizontal", "headerRule", "none"]);

/**
 * Per-cell borders for a scheme, written the same way the visual presets do
 * (direct cell formatting, portable without a table style). `szEighths` is the
 * OOXML line width in eighths of a point.
 */
function applyBorderScheme(
  editor: Editor,
  idx: number,
  scheme: BorderScheme,
  color: string,
  szEighths: number,
): boolean {
  const info = docTableAt(editor, idx);
  if (!info) return false;
  const { map, tableStart, node } = info;
  const line = { style: "single", szEighths, color };
  const none = null;
  let tr = editor.state.tr;
  const lastRow = map.height - 1;
  node.forEach((row, rowOffset, rowIndex) => {
    row.forEach((cell, cellOffset) => {
      const cellPos = tableStart + rowOffset + 1 + cellOffset;
      const rect = map.findCell(cellPos - tableStart);
      const top = rect.top === 0;
      const bottom = rect.bottom === map.height;
      const left = rect.left === 0;
      const right = rect.right === map.width;
      let borders: Record<string, unknown> | null;
      switch (scheme) {
        case "all":
          borders = { top: line, right: line, bottom: line, left: line };
          break;
        case "outside":
          borders = { top: top ? line : none, right: right ? line : none, bottom: bottom ? line : none, left: left ? line : none };
          break;
        case "horizontal":
          borders = { top: line, bottom: line, left: none, right: none };
          break;
        case "headerRule":
          borders = {
            top: none,
            left: none,
            right: none,
            bottom: rowIndex === 0 || rect.bottom - 1 === lastRow ? line : none,
          };
          break;
        default:
          borders = null;
      }
      tr = tr.setNodeMarkup(cellPos, undefined, { ...cell.attrs, borders });
    });
  });
  // Table-level borders would otherwise draw over cleared cell borders.
  tr = tr.setNodeMarkup(tableStart - 1, undefined, { ...node.attrs, borders: null, tblStyleId: null });
  editor.view.dispatch(tr);
  return true;
}

/** Merge the rectangle (r0,c0)–(r1,c1) through prosemirror-tables' mergeCells. */
function mergeTableCells(editor: Editor, idx: number, r0: number, c0: number, r1: number, c1: number): boolean {
  const info = docTableAt(editor, idx);
  if (!info) return false;
  const { map, tableStart } = info;
  const anchor = tableStart + map.map[r0 * map.width + c0]!;
  const head = tableStart + map.map[r1 * map.width + c1]!;
  editor.view.focus();
  editor.view.dispatch(
    editor.state.tr.setSelection(CellSelection.create(editor.state.doc, anchor, head)),
  );
  return mergeCells(editor.state, editor.view.dispatch);
}

/** Plain text of one top-level block (table cells joined with tabs, rows with newlines). */
function blockPlainText(block: ProseMirrorNode): string {
  if (block.type.name === "docProtected" || isTrackedDeleted(block)) return "";
  if (block.type.name === "docTable") {
    const rows: string[] = [];
    block.forEach((row) => {
      const cells: string[] = [];
      row.forEach((cell) => cells.push(cell.textContent));
      rows.push(cells.join("\t"));
    });
    return rows.join("\n");
  }
  return block.textContent;
}

/** Place a single-cell CellSelection at (row,col) then run a prosemirror-tables command. */
function runTableCellCommand(
  editor: Editor,
  idx: number,
  row: number,
  col: number,
  command: PmCommand,
): boolean {
  const info = docTableAt(editor, idx);
  if (!info) return false;
  const { map, tableStart } = info;
  if (row < 0 || col < 0 || row >= map.height || col >= map.width) return false;
  const cellPos = tableStart + map.map[row * map.width + col]!;
  editor.view.focus();
  editor.view.dispatch(
    editor.state.tr.setSelection(CellSelection.create(editor.state.doc, cellPos)),
  );
  return command(editor.state, editor.view.dispatch);
}

function validRange(
  editor: Editor,
  start: unknown,
  end: unknown,
): { start: number; end: number } | null {
  const count = editor.state.doc.childCount;
  if (!Number.isInteger(start) || !Number.isInteger(end)) return null;
  const s = Number(start);
  const e = Number(end);
  // an out-of-range end must surface as an error, not silently clamp onto the wrong blocks
  if (s < 0 || e < s || e >= count) return null;
  return { start: s, end: e };
}

/** Read the natural size of a dataURL image. */
function imageSizeOf(dataUrl: string): Promise<{ width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve({ width: img.naturalWidth || 1, height: img.naturalHeight || 1 });
    img.onerror = () => reject(new Error("image load failed"));
    img.src = dataUrl;
  });
}

/** Async tools: web search / image search / insert web image. */
async function executeAsyncTool(
  editor: Editor,
  call: AgentToolCall,
  signal?: AbortSignal,
): Promise<ToolExecution> {
  switch (call.name) {
    case "web_search": {
      const query = String(call.input.query ?? "").trim();
      if (!query) return fail(t("aiSumWebSearch"), "query must not be empty");
      const r = await window.desktop.webSearch(query, Number(call.input.maxResults) || 6);
      // a backend failure must not read as "no results" — the model would fabricate conclusions
      if (r.method === "error") {
        return fail(
          t("aiSumWebSearch"),
          `web search failed (service error, not an empty result — you may retry): ${r.error ?? "unknown error"}`,
        );
      }
      const lines: string[] = [];
      if (r.answer) lines.push(`Direct answer: ${r.answer}\n`);
      r.results.forEach((it, i) =>
        lines.push(`${i + 1}. ${it.title}\n   ${it.url}\n   ${it.snippet}`),
      );
      return {
        output: lines.join("\n") || "(no results)",
        mutated: false,
        summary: t("aiSumWebSearchDone", { query, count: r.results.length }),
      };
    }
    case "image_search": {
      const query = String(call.input.query ?? "").trim();
      if (!query) return fail(t("aiSumImageSearch"), "query must not be empty");
      const r = await window.desktop.imageSearch(query, Number(call.input.maxResults) || 8);
      // a backend failure must not read as an empty gallery — the model would fabricate image choices
      if (r.method === "error") {
        return fail(
          t("aiSumImageSearch"),
          `image search failed (service error, not an empty result — you may retry): ${r.error ?? "unknown error"}`,
        );
      }
      const lines = r.images.map(
        (im, i) =>
          `${i + 1}. ${im.title || "(untitled)"} [${im.width ?? "?"}x${im.height ?? "?"}]\n   ${im.imageUrl}`,
      );
      return {
        output: lines.join("\n") || "(no images)",
        mutated: false,
        summary: t("aiSumImageSearchDone", { query, count: r.images.length }),
      };
    }
    case "insert_image": {
      const url = String(call.input.url ?? "").trim();
      // Accepts a direct http(s) URL or a platform-image:<id> handle from
      // generate_image / render_diagram / run_python / edit_image.
      if (!/^https?:\/\//.test(url) && !isPlatformImage(url))
        return fail(
          t("aiSumInsertImage"),
          "url must be an http(s) URL or a platform-image:<id> handle",
        );
      return insertImageFromUrl(editor, url, Number(call.input.maxWidthPx) || 480, signal, {
        failLabel: t("aiSumInsertImage"),
        doneLabel: t("aiSumInsertWebImage"),
        blockLabel: "Image (web)",
      });
    }
    case "generate_image": {
      // Platform build: Amazon Nova Canvas through the platform, then the same
      // protected-image insertion as a downloaded picture.
      const prompt = String(call.input.prompt ?? "").trim();
      if (!prompt) return fail(t("aiSumGenerateImage"), "prompt must not be empty");
      const aspectRatio = String(call.input.aspectRatio ?? "").trim();
      const negativePrompt = String(call.input.negativePrompt ?? "").trim();
      let generated: { mime: "image/png" | "image/jpeg"; base64: string };
      try {
        const { officeGenerateImageFn } = await import("@/lib/office/tools.functions");
        generated = await officeGenerateImageFn({
          data: {
            prompt,
            ...(aspectRatio ? { aspectRatio } : {}),
            ...(negativePrompt ? { negativePrompt } : {}),
          },
        });
      } catch (e) {
        return fail(
          t("aiSumGenerateImage"),
          e instanceof Error ? e.message : "image generation failed",
        );
      }
      if (signal?.aborted)
        return fail(t("aiSumGenerateImage"), "stopped by the user; the image was not inserted");
      return insertImageBase64(
        editor,
        generated.base64,
        Number(call.input.maxWidthPx) || 480,
        signal,
        {
          failLabel: t("aiSumGenerateImage"),
          doneLabel: t("aiSumInsertedGenImage"),
          blockLabel: "Image (AI)",
        },
      );
    }
    case "create_document": {
      // Platform build: the new document lands in the Library (docx opens in
      // the Writer, pptx in Slides, pdf downloads); the current document is untouched.
      const typeRaw = call.input.type === undefined ? "docx" : String(call.input.type);
      if (typeRaw !== "docx" && typeRaw !== "pdf" && typeRaw !== "md" && typeRaw !== "pptx")
        return fail(t("aiSumCreateDocument"), "type must be one of docx/pptx/pdf/md");
      const type = typeRaw as CreateDocumentType | "pptx";
      const title = String(call.input.title ?? "").trim();
      if (!title) return fail(t("aiSumCreateDocument"), "title must not be empty");
      const content = String(call.input.content ?? "");
      if (!content.trim()) return fail(t("aiSumCreateDocument"), "content must not be empty");
      if (type !== "md") {
        const echo = toolEchoError(content);
        if (echo) return fail(t("aiSumCreateDocument"), echo);
        try {
          if (parseHtmlFragment(content, { bullet: null, ordered: null }).length === 0)
            return fail(t("aiSumCreateDocument"), "content did not parse into any content blocks");
        } catch (e) {
          return fail(t("aiSumCreateDocument"), e instanceof Error ? e.message : String(e));
        }
      }
      try {
        const { officeCreateDocumentFn } = await import("@/lib/office/tools.functions");
        const r = await officeCreateDocumentFn({
          data: {
            taskId: taskForEditor(editor),
            kind: type === "md" ? "docx" : type,
            title,
            markdown: content,
            format: type === "md" ? "markdown" : "html",
          },
        });
        if (r.kind === "pdf") {
          const bytes = Uint8Array.from(atob(r.base64), (c) => c.charCodeAt(0));
          const url = URL.createObjectURL(new Blob([bytes], { type: "application/pdf" }));
          const a = document.createElement("a");
          a.href = url;
          a.download = r.name;
          a.click();
          setTimeout(() => URL.revokeObjectURL(url), 30_000);
          return {
            output: `Created ${r.name}; the browser downloaded it.`,
            mutated: false,
            summary: t("aiSumCreatedDocument", { name: r.name }),
          };
        }
        const href = `${location.origin}${r.url}`;
        return {
          output: `Created "${r.doc.name}" in the Library. Open it at ${href} . Tell the user it is ready and give this link.`,
          mutated: false,
          summary: t("aiSumCreatedDocument", { name: r.doc.name }),
          display: { kind: "links", items: [{ url: href, title: r.doc.name }] },
        };
      } catch (e) {
        return fail(
          t("aiSumCreateDocument"),
          e instanceof Error ? e.message : "creating the document failed",
        );
      }
    }
    default:
      return fail(t("aiSumUnknownTool"), call.name);
  }
}

/** magic-byte sniff: the fetch handler's content-type mapping defaults unknown
 *  types to jpeg, and a webp/svg mislabeled as jpeg breaks the exported docx */
export function sniffImageMime(base64: string): "image/png" | "image/jpeg" | "image/gif" | null {
  let head: string;
  try {
    head = atob(base64.slice(0, 12));
  } catch {
    return null;
  }
  if (head.startsWith("\x89PNG")) return "image/png";
  if (head.startsWith("GIF8")) return "image/gif";
  if (head.charCodeAt(0) === 0xff && head.charCodeAt(1) === 0xd8) return "image/jpeg";
  return null;
}

/** download a direct image URL (or resolve a platform-image handle) and insert it at the cursor as a protected image block */
async function insertImageFromUrl(
  editor: Editor,
  url: string,
  maxW: number,
  signal: AbortSignal | undefined,
  labels: { failLabel: string; doneLabel: string; blockLabel: string },
): Promise<ToolExecution> {
  if (isPlatformImage(url)) {
    const stored = getPlatformImage(url);
    if (!stored)
      return fail(
        labels.failLabel,
        "that image handle is no longer available; produce the image again",
      );
    return insertImageBase64(editor, stored.base64, maxW, signal, labels);
  }
  const fetched = await window.desktop.fetchImage(url);
  // never write after the user hit stop (the download may resolve long after the abort)
  if (signal?.aborted)
    return fail(labels.failLabel, "stopped by the user; the image was not inserted");
  if (!fetched) return fail(labels.failLabel, "download failed (the image may not be accessible)");
  return insertImageBase64(editor, fetched.base64, maxW, signal, labels);
}

/** insert raw image bytes (base64) at the cursor as a protected image block */
async function insertImageBase64(
  editor: Editor,
  base64: string,
  maxW: number,
  signal: AbortSignal | undefined,
  labels: { failLabel: string; doneLabel: string; blockLabel: string },
): Promise<ToolExecution> {
  const fetched = { base64 };
  const mime = sniffImageMime(fetched.base64);
  if (!mime) {
    return fail(
      labels.failLabel,
      "unsupported image format (only png/jpg/gif can be embedded) — pick a different image",
    );
  }
  const dataUrl = `data:${mime};base64,${fetched.base64}`;
  try {
    const natural = await imageSizeOf(dataUrl);
    if (signal?.aborted)
      return fail(labels.failLabel, "stopped by the user; the image was not inserted");
    const scale = Math.min(1, maxW / natural.width);
    const w = Math.round(natural.width * scale);
    const h = Math.round(natural.height * scale);
    // The download can take long: user edits made meanwhile must keep the
    // freshness baseline stale, so only our own insertion may mark the doc
    // seen. Checked right before the write — there is no async gap after.
    const userEditedDuringFetch = editedExternally(editor);
    editor
      .chain()
      .focus()
      .insertContent({
        type: "docProtected",
        attrs: {
          docxIndex: null,
          blockType: "image",
          label: labels.blockLabel,
          imageDataUrl: dataUrl,
          imageWidthPx: w,
          imageHeightPx: h,
          genImage: { base64: fetched.base64, mime, widthPx: w, heightPx: h },
        },
      })
      .run();
    if (!userEditedDuringFetch) markDocSeen(editor);
    return {
      output: `Inserted the image (${w}×${h}px).`,
      mutated: true,
      summary: labels.doneLabel,
    };
  } catch {
    return fail(labels.failLabel, "the image could not be decoded");
  }
}

export function executeTool(
  editor: Editor,
  call: AgentToolCall,
  numIds: NumIds,
  track?: AiTrack,
  signal?: AbortSignal,
  frozen?: FrozenSelection | null,
  comments?: AiCommentsAccess,
  hf?: AiHeaderFooterAccess,
  app?: AiDocumentAccess,
): ToolExecution | Promise<ToolExecution> {
  const scope = frozen && frozen.doc === editor.state.doc ? frozen.scope : null;
  activeEditor = editor;
  activeNumIds = numIds;
  activeTrack = track;
  const staleSummary = INDEX_WRITE_SUMMARIES[call.name];
  if (staleSummary && editedExternally(editor)) return fail(staleSummary(), STALE_DOC_ERROR);
  if (call.name === "view_page") return viewPage(editor, call);
  const settle = (exec: ToolExecution): ToolExecution => {
    const readsDoc = [
      "get_document_context",
      "read_blocks",
      "read_document_outline",
      "search_document",
    ].includes(call.name);
    if (exec.mutated || (readsDoc && !exec.isError)) markDocSeen(editor);
    return exec;
  };
  // Async tools take a separate Promise branch; the other sync tools keep returning
  // synchronously (doesn't break existing tests). No settle here: marking the doc
  // seen after the long download would baptize user edits made meanwhile —
  // insert_image maintains the baseline itself right at its synchronous write.
  if (PLATFORM_TOOL_NAMES.has(call.name)) {
    // Platform tools never touch the document; normalize the shared shape to
    // the Writer's (mutated is required here).
    return Promise.resolve(platformSkill.executeTool(call, signal)).then((exec) => ({
      ...exec,
      mutated: exec.mutated ?? false,
    }));
  }
  if (
    call.name === "web_search" ||
    call.name === "image_search" ||
    call.name === "insert_image" ||
    call.name === "generate_image" ||
    call.name === "create_document"
  ) {
    return executeAsyncTool(editor, call, signal);
  }
  return settle(executeSyncTool(editor, call, numIds, track, scope, comments, hf, app));
}

function executeSyncTool(
  editor: Editor,
  call: AgentToolCall,
  numIds: NumIds,
  track?: AiTrack,
  scope?: SelectionScope | null,
  comments?: AiCommentsAccess,
  hf?: AiHeaderFooterAccess,
  app?: AiDocumentAccess,
): ToolExecution {
  switch (call.name) {
    case "read_document_outline":
    case "search_document":
      try {
        return {
          output: JSON.stringify(
            navigateDocument(editor.state.doc, call.input, call.name === "search_document"),
          ),
          mutated: false,
          summary:
            call.name === "search_document" ? "Searched document text" : "Read document outline",
        };
      } catch (error) {
        return fail("Document navigation", error instanceof Error ? error.message : String(error));
      }
    case "get_document_context":
      return {
        // the still-valid frozen scope keeps the reported selection consistent
        // with what scope:'selection' and cursor-relative inserts will act on
        output: buildDocumentContext(editor, scope ?? undefined, hf?.read()),
        mutated: false,
        summary: t("aiSumReadDocContext"),
      };

    case "read_blocks": {
      const range = validRange(editor, call.input.startBlockIndex, call.input.endBlockIndex);
      if (!range) return fail(t("aiSumReadBlocks"), rangeError(editor));
      const html = serializeRangeToHtml(editor, range.start, range.end);
      const offset = Math.max(0, Math.trunc(Number(call.input.offset)) || 0);
      if (offset > 0 && offset >= html.length) {
        return fail(
          t("aiSumReadBlocks"),
          `offset ${offset} is beyond the content (${html.length} characters in total)`,
        );
      }
      const slice = html.slice(offset, offset + READ_MAX_CHARS);
      const end = offset + slice.length;
      const note =
        end < html.length
          ? `\n…(truncated: ${html.length} characters in total, call read_blocks again with offset=${end} to continue)`
          : offset > 0
            ? `\n(end of range: ${html.length} characters in total)`
            : "";
      let empty = "(range is empty)";
      if (!slice) {
        let deletedBlocks = 0;
        for (let i = range.start; i <= range.end; i++) {
          if (isTrackedDeleted(editor.state.doc.child(i))) deletedBlocks++;
        }
        if (deletedBlocks > 0) {
          empty = `(the ${deletedBlocks} block(s) in this range are pending tracked deletions — that text is already deleted and hidden from reads; do not delete or rewrite it again)`;
        }
      }
      return {
        output: slice ? slice + note : empty,
        mutated: false,
        summary: t("aiSumReadBlocksRange", { start: range.start, end: range.end }),
      };
    }

    case "insert_content": {
      const html = String(call.input.html ?? "");
      const echo = toolEchoError(html);
      if (echo) return fail(t("aiSumInsertContent"), echo);
      let nodes: ReturnType<typeof parseHtmlFragment>;
      try {
        nodes = parseHtmlFragment(html, numIds);
      } catch (e) {
        return fail(t("aiSumInsertContent"), e instanceof Error ? e.message : String(e));
      }
      if (nodes.length === 0)
        return fail(t("aiSumInsertContent"), "html did not parse into any content blocks");
      const count = editor.state.doc.childCount;
      if (isBlankDocument(editor)) {
        // the blank template's single empty paragraph gets replaced
        replaceBlockRange(editor, 0, count - 1, nodes, track);
        return {
          output: `Inserted ${nodes.length} block(s) (the document was empty). Block indexes have changed; use get_document_context if needed.`,
          mutated: true,
          summary: t("aiSumInsertedBlocks", { count: nodes.length }),
        };
      }
      const cursorScope = call.input.afterBlockIndex === undefined;
      const after = cursorScope
        ? getCursorBlockIndex(editor, scope)
        : Math.min(Math.max(Number(call.input.afterBlockIndex), -1), count - 1);
      if (!Number.isInteger(after)) return fail(t("aiSumInsertContent"), "invalid afterBlockIndex");
      // -1 hits blockRangePositions' 0/0 default, i.e. insert at doc start
      insertBlocksAfter(editor, after, nodes, track);
      return {
        output: `Inserted ${nodes.length} block(s) after block ${after}. Subsequent block indexes have shifted; use get_document_context if needed.`,
        mutated: true,
        summary: t("aiSumInsertedBlocks", { count: nodes.length }),
      };
    }

    case "replace_blocks": {
      const range = validRange(editor, call.input.startBlockIndex, call.input.endBlockIndex);
      if (!range) return fail(t("aiSumReplaceContent"), rangeError(editor));
      const html = String(call.input.html ?? "");
      const echo = toolEchoError(html);
      if (echo) return fail(t("aiSumReplaceContent"), echo);
      let nodes: ReturnType<typeof parseHtmlFragment>;
      try {
        nodes = parseHtmlFragment(html, numIds);
      } catch (e) {
        return fail(t("aiSumReplaceContent"), e instanceof Error ? e.message : String(e));
      }
      if (nodes.length === 0)
        return fail(t("aiSumReplaceContent"), "html did not parse into any content blocks");
      replaceBlockRange(editor, range.start, range.end, nodes, track);
      return {
        output: `Replaced blocks ${range.start}-${range.end} with ${nodes.length} block(s); the new blocks kept the replaced blocks' formatting. Block indexes have changed; use get_document_context if needed.`,
        mutated: true,
        summary: t("aiSumReplacedBlocks", { start: range.start, end: range.end }),
      };
    }

    case "insert_chart": {
      const kind = String(call.input.kind ?? "") as NewChart["kind"];
      if (!["bar", "line", "pie"].includes(kind))
        return fail(t("aiSumInsertChart"), "kind must be one of bar/line/pie");
      const categories = Array.isArray(call.input.categories)
        ? (call.input.categories as unknown[]).map((c) => String(c ?? ""))
        : [];
      const seriesIn = Array.isArray(call.input.series)
        ? (call.input.series as ReadonlyArray<{ name?: unknown; values?: unknown } | null>)
        : [];
      if (!categories.length || !seriesIn.length)
        return fail(t("aiSumInsertChart"), "categories and series must not be empty");
      const series = seriesIn.map((s, i) => {
        const values: unknown[] = Array.isArray(s?.values) ? s.values : [];
        return {
          name: String(s?.name ?? `Series ${i + 1}`),
          values: categories.map((_, j) => {
            const v = values[j] ?? null;
            const n = Number(v);
            return v != null && Number.isFinite(n) ? n : null;
          }),
        };
      });
      const title = String(call.input.title ?? "").trim() || "Chart title";
      const spec: NewChart = { kind, title, categories, series };
      const display: ChartDisplay = { partPath: "", kind, title, categories, series };
      const count = editor.state.doc.childCount;
      const after =
        call.input.afterBlockIndex === undefined
          ? getCursorBlockIndex(editor, scope)
          : Math.min(Math.max(Number(call.input.afterBlockIndex), -1), count - 1);
      if (!Number.isInteger(after)) return fail(t("aiSumInsertChart"), "invalid afterBlockIndex");
      const { to } = blockRangePositions(editor, after, after);
      editor
        .chain()
        .insertContentAt(to, {
          type: "docProtected",
          attrs: {
            docxIndex: null,
            blockType: "chart",
            label: "Chart",
            genChart: spec,
            chartDisplay: display,
          },
        })
        .run();
      return {
        output: `Inserted a ${kind} chart "${title}" (${categories.length} categories × ${series.length} series).`,
        mutated: true,
        summary: t("aiSumInsertedChart", { title }),
      };
    }

    case "edit_chart": {
      const idx = Number(call.input.blockIndex);
      if (!Number.isInteger(idx) || idx < 0 || idx >= editor.state.doc.childCount) {
        return fail(t("aiSumEditChart"), "blockIndex invalid or out of range");
      }
      const node = editor.state.doc.child(idx);
      // native docx charts are passthrough blocks + chartDisplay; AI/UI-created ones are blockType 'chart'
      const display =
        node.type.name === "docProtected" ? (node.attrs.chartDisplay as ChartDisplay | null) : null;
      if (!display)
        return fail(
          t("aiSumEditChart"),
          `block ${idx} is not a chart (or the chart has no editable data cache)`,
        );
      const isNative = display.partPath !== ""; // native chart part from docx: data-point structure is immutable
      const next: ChartDisplay = {
        ...display,
        categories: [...display.categories],
        series: display.series.map((s) => ({ ...s, values: [...s.values] })),
      };
      if (call.input.title !== undefined) next.title = String(call.input.title);
      if (call.input.categories !== undefined) {
        const cats = call.input.categories;
        if (!Array.isArray(cats) || cats.length !== display.categories.length) {
          return fail(
            t("aiSumEditChart"),
            `categories must match the original category count (${display.categories.length})`,
          );
        }
        cats.forEach((c, i) => {
          if (c != null) next.categories[i] = String(c);
        });
      }
      const serIn = Array.isArray(call.input.series)
        ? (call.input.series as ReadonlyArray<{
            index?: unknown;
            name?: unknown;
            values?: unknown;
          } | null>)
        : [];
      for (const s of serIn) {
        const si = Number(s?.index);
        const orig = display.series[si];
        if (!Number.isInteger(si) || !orig)
          return fail(
            t("aiSumEditChart"),
            `series index ${s?.index} is invalid (${display.series.length} series in total)`,
          );
        if (s?.name !== undefined) next.series[si]!.name = String(s.name);
        if (s?.values !== undefined) {
          const values: unknown[] | null = Array.isArray(s.values) ? s.values : null;
          if (!values || values.length !== orig.values.length) {
            return fail(
              t("aiSumEditChart"),
              `values of series ${si} must match the original series length (${orig.values.length})`,
            );
          }
          for (let j = 0; j < values.length; j++) {
            const v = values[j];
            if (v == null) continue;
            const n = Number(v);
            if (!Number.isFinite(n))
              return fail(t("aiSumEditChart"), `value ${j} of series ${si} is not a number`);
            if (isNative && orig.values[j] == null) {
              return fail(
                t("aiSumEditChart"),
                `data point ${j} of series ${si} is empty in the original chart; empty points of a native chart cannot be written`,
              );
            }
            next.series[si]!.values[j] = n;
          }
        }
      }
      // generated charts (genChart) update the spec in sync; the chart part is rebuilt from the new data on save
      const gen = node.attrs.genChart as NewChart | null;
      const nextGen: NewChart | null = gen
        ? {
            ...gen,
            title: next.title ?? gen.title,
            categories: [...next.categories],
            series: next.series.map((s) => ({ name: s.name ?? "", values: [...s.values] })),
          }
        : null;
      const { from } = blockRangePositions(editor, idx, idx);
      editor.view.dispatch(
        editor.state.tr.setNodeMarkup(from, undefined, {
          ...node.attrs,
          chartDisplay: next,
          genChart: nextGen,
        }),
      );
      return {
        output: `Updated the data of chart "${next.title ?? ""}" (changes are written back to the chart on save).`,
        mutated: true,
        summary: t("aiSumEditedChart", { index: idx }),
      };
    }

    case "insert_page_break": {
      const count = editor.state.doc.childCount;
      const requested = call.input.beforeBlockIndex;
      const before =
        requested === undefined || requested === null
          ? getCursorBlockIndex(editor, scope) + 1
          : Number(requested);
      if (!Number.isInteger(before) || before < 0 || before > count) {
        return fail(t("aiSumInsertContent"), `beforeBlockIndex must be between 0 and ${count}`);
      }
      const remove = call.input.remove === true;
      if (before === count) {
        if (remove) return fail(t("aiSumInsertContent"), "there is no block after the last one");
        insertBlocksAfter(
          editor,
          count - 1,
          [{ type: "docParagraph", attrs: { pageBreakBefore: true } }],
          track,
        );
        return {
          output: `Appended a new page at the end of the document (block ${count}).`,
          mutated: true,
          summary: t("aiSumInsertContent"),
        };
      }
      const node = editor.state.doc.child(before);
      const carriesBreak = node.isTextblock && "pageBreakBefore" in node.attrs;
      const { from } = blockRangePositions(editor, before, before);
      if (remove) {
        if (carriesBreak && node.attrs.pageBreakBefore === true) {
          editor.view.dispatch(
            editor.state.tr.setNodeMarkup(from, undefined, {
              ...node.attrs,
              pageBreakBefore: false,
              aiChanged: true,
            }),
          );
          return {
            output: `Removed the page break before block ${before}.`,
            mutated: true,
            summary: t("aiSumInsertContent"),
          };
        }
        const prev = before > 0 ? editor.state.doc.child(before - 1) : null;
        if (
          prev &&
          prev.type.name === "docParagraph" &&
          prev.childCount === 0 &&
          prev.attrs.pageBreakBefore === true
        ) {
          const range = blockRangePositions(editor, before - 1, before - 1);
          editor.view.dispatch(editor.state.tr.delete(range.from, range.to));
          return {
            output: `Removed the break paragraph before block ${before}. Subsequent block indexes shifted by -1.`,
            mutated: true,
            summary: t("aiSumInsertContent"),
          };
        }
        return {
          output: `Block ${before} does not start a new page; nothing to remove.`,
          mutated: false,
          summary: t("aiSumInsertContent"),
        };
      }
      if (carriesBreak) {
        if (node.attrs.pageBreakBefore === true) {
          return {
            output: `Block ${before} already starts a new page.`,
            mutated: false,
            summary: t("aiSumInsertContent"),
          };
        }
        editor.view.dispatch(
          editor.state.tr.setNodeMarkup(from, undefined, {
            ...node.attrs,
            pageBreakBefore: true,
            aiChanged: true,
          }),
        );
        return {
          output: `Block ${before} now starts a new page (Word page break before it). Block indexes are unchanged.`,
          mutated: true,
          summary: t("aiSumInsertContent"),
        };
      }
      // Tables, images and other protected blocks cannot carry the attribute:
      // give them Word's explicit break paragraph instead.
      insertBlocksAfter(
        editor,
        before - 1,
        [{ type: "docParagraph", attrs: { pageBreakBefore: true } }],
        track,
      );
      return {
        output: `Inserted a page break before block ${before} (it is now block ${before + 1}; later indexes shifted by +1).`,
        mutated: true,
        summary: t("aiSumInsertContent"),
      };
    }

    case "insert_table": {
      const headers = Array.isArray(call.input.headers)
        ? (call.input.headers as unknown[]).map((h) => String(h ?? ""))
        : [];
      const bodyRows: string[][] = Array.isArray(call.input.rows)
        ? (call.input.rows as unknown[]).map((r) =>
            Array.isArray(r) ? (r as unknown[]).map((c) => String(c ?? "")) : [String(r ?? "")],
          )
        : [];
      if (!bodyRows.length && !headers.length)
        return fail(t("aiSumInsertContent"), "rows must not be empty");
      const cols = Math.max(headers.length, ...bodyRows.map((r) => r.length), 1);
      const preset =
        TABLE_PRESETS[String(call.input.stylePreset ?? "firmNavy")] ?? TABLE_PRESETS["firmNavy"]!;
      const widthsIn = Array.isArray(call.input.colWidths)
        ? (call.input.colWidths as unknown[]).map((w) => Number(w))
        : [];
      const validWidths =
        widthsIn.length === cols && widthsIn.every((n) => Number.isFinite(n) && n > 0);
      const widthSum = validWidths ? widthsIn.reduce((a, b) => a + b, 0) : 0;
      const colWidthsPct = validWidths
        ? widthsIn.map((w) => (w / widthSum) * 100)
        : Array.from({ length: cols }, () => 100 / cols);
      const hasHeader = headers.length > 0;
      const modelRows: TableCell[][] = [];
      if (hasHeader) modelRows.push(tableRowCells(headers, cols, 0, true, preset));
      bodyRows.forEach((r, i) =>
        modelRows.push(tableRowCells(r, cols, hasHeader ? i + 1 : i, false, preset)),
      );
      const line = {
        style: "single",
        szEighths: 4,
        color: preset.border ? preset.borderColor : "auto",
      };
      const table = {
        rows: modelRows,
        colWidthsPct,
        ...(preset.border
          ? {
              borders: {
                top: line,
                bottom: line,
                left: line,
                right: line,
                insideH: line,
                insideV: line,
              },
            }
          : {}),
      };
      const count = editor.state.doc.childCount;
      const after =
        call.input.afterBlockIndex === undefined
          ? getCursorBlockIndex(editor, scope)
          : Math.min(Math.max(Number(call.input.afterBlockIndex), -1), count - 1);
      if (!Number.isInteger(after)) return fail(t("aiSumInsertContent"), "invalid afterBlockIndex");
      insertBlocksAfter(editor, after, [tableModelToPmNode(table)], track);
      return {
        output: `Inserted a ${modelRows.length}×${cols} table${hasHeader ? " with a header row" : ""} after block ${after}. Subsequent block indexes shifted; call get_document_context if needed.`,
        mutated: true,
        summary: t("aiSumInsertContent"),
      };
    }

    case "edit_table": {
      const idx = Number(call.input.blockIndex);
      if (!docTableAt(editor, idx))
        return fail(
          t("aiSumInsertContent"),
          `block ${call.input.blockIndex} is not a table (type "table" in the block list)`,
        );
      const structural = ["addRow", "addColumn", "deleteRow", "deleteColumn"].filter(
        (k) => call.input[k] !== undefined && call.input[k] !== null,
      );
      if (structural.length > 1)
        return fail(
          t("aiSumInsertContent"),
          "apply at most one row/column add-or-delete per call (indexes shift); setCells and restyle may accompany it",
        );
      const done: string[] = [];
      const setCells = Array.isArray(call.input.setCells)
        ? (call.input.setCells as ReadonlyArray<{
            row?: unknown;
            col?: unknown;
            text?: unknown;
          } | null>)
        : [];
      let cellCount = 0;
      for (const sc of setCells) {
        const r = Number(sc?.row);
        const c = Number(sc?.col);
        if (!Number.isInteger(r) || !Number.isInteger(c)) continue;
        if (setTableCellText(editor, idx, r, c, String(sc?.text ?? ""))) cellCount++;
      }
      if (cellCount) done.push(`${cellCount} cell${cellCount === 1 ? "" : "s"} set`);
      const addRow = call.input.addRow as { at?: unknown; position?: unknown } | null | undefined;
      if (addRow && typeof addRow === "object") {
        const at = Number.isInteger(Number(addRow.at)) ? Number(addRow.at) : 0;
        const before = String(addRow.position ?? "after") === "before";
        if (runTableCellCommand(editor, idx, at, 0, before ? addRowBefore : addRowAfter))
          done.push(`row ${before ? "inserted before" : "inserted after"} ${at}`);
      }
      const addColumn = call.input.addColumn as
        | { at?: unknown; position?: unknown }
        | null
        | undefined;
      if (addColumn && typeof addColumn === "object") {
        const at = Number.isInteger(Number(addColumn.at)) ? Number(addColumn.at) : 0;
        const before = String(addColumn.position ?? "after") === "before";
        if (runTableCellCommand(editor, idx, 0, at, before ? addColumnBefore : addColumnAfter))
          done.push(`column ${before ? "inserted before" : "inserted after"} ${at}`);
      }
      if (call.input.deleteRow !== undefined && call.input.deleteRow !== null) {
        const r = Number(call.input.deleteRow);
        if (runTableCellCommand(editor, idx, Number.isInteger(r) ? r : -1, 0, deleteRow))
          done.push(`row ${r} deleted`);
      }
      if (call.input.deleteColumn !== undefined && call.input.deleteColumn !== null) {
        const c = Number(call.input.deleteColumn);
        if (runTableCellCommand(editor, idx, 0, Number.isInteger(c) ? c : -1, deleteColumn))
          done.push(`column ${c} deleted`);
      }
      const restyle = call.input.restyle !== undefined ? String(call.input.restyle) : null;
      if (restyle) {
        const preset = TABLE_PRESETS[restyle] ?? TABLE_PRESETS["none"]!;
        if (runTableCellCommand(editor, idx, 0, 0, applyTablePreset(preset)))
          done.push(`restyled ${restyle}`);
      }
      if (!done.length)
        return fail(
          t("aiSumInsertContent"),
          "no valid edit was specified (or a row/column index was out of range)",
        );
      return {
        output: `Edited table at block ${idx}: ${done.join("; ")}. Structural changes shift row/column indexes; call get_document_context before editing this table again.`,
        mutated: true,
        summary: t("aiSumInsertContent"),
      };
    }

    case "read_revisions":
      return {
        output: buildRevisionsContext(editor),
        mutated: false,
        summary: t("aiSumReadRevisions"),
      };

    case "read_comments": {
      if (!comments) return fail(t("aiSumReadComments"), "comments are not available here");
      return {
        output: buildCommentsContext(editor, comments.list(), true),
        mutated: false,
        summary: t("aiSumReadComments"),
      };
    }

    case "reply_comment": {
      if (!comments) return fail(t("aiSumReplyComment"), "comments are not available here");
      const parentId = String(call.input.parentId ?? "").trim();
      const text = String(call.input.text ?? "").trim();
      if (!parentId || !text) {
        return fail(t("aiSumReplyComment"), "parentId and text must not be empty");
      }
      const target = comments.list().find((c) => c.id === parentId);
      if (!target) {
        return fail(
          t("aiSumReplyComment"),
          `no comment with id ${parentId}; call read_comments for the current ids`,
        );
      }
      const rootId = target.parentId ?? target.id; // replies always attach to the thread root
      if (!comments.reply(rootId, text)) {
        return fail(
          t("aiSumReplyComment"),
          "the comment anchor no longer exists in the document; the reply was not added",
        );
      }
      return {
        output: `Replied to comment ${rootId}.`,
        mutated: true, // the reply id joins the anchor marks, so the doc changed
        summary: t("aiSumReplyComment"),
      };
    }

    case "resolve_comment": {
      if (!comments) return fail(t("aiSumResolveComment"), "comments are not available here");
      const id = String(call.input.id ?? "").trim();
      const target = comments.list().find((c) => c.id === id);
      if (!target) {
        return fail(
          t("aiSumResolveComment"),
          `no comment with id ${id}; call read_comments for the current ids`,
        );
      }
      const rootId = target.parentId ?? target.id;
      if (!comments.resolve(rootId)) {
        return fail(t("aiSumResolveComment"), `comment ${rootId} could not be resolved`);
      }
      return {
        output: `Comment ${rootId} marked as resolved.`,
        mutated: false, // app state only; the document content is untouched
        summary: t("aiSumResolveComment"),
      };
    }

    case "set_header_footer": {
      const kind = String(call.input.kind ?? "");
      const summaryOf = () => t(kind === "footer" ? "aiSumSetFooter" : "aiSumSetHeader");
      if (!hf) return fail(summaryOf(), "header/footer editing is not available here");
      if (kind !== "header" && kind !== "footer") {
        return fail(summaryOf(), 'kind must be "header" or "footer"');
      }
      const view = call.input.view === undefined ? "default" : String(call.input.view);
      if (view !== "default" && view !== "first" && view !== "even") {
        return fail(summaryOf(), 'view must be "default", "first" or "even"');
      }
      if (typeof call.input.text !== "string") return fail(summaryOf(), "text must be a string");
      const text = call.input.text;
      if (text.length > 2000) {
        return fail(summaryOf(), "text is too long for a header/footer (2000 characters max)");
      }
      const error = hf.set(kind, view, text);
      if (error) return fail(summaryOf(), error);
      return {
        output: `Updated the ${kind}${view !== "default" ? ` (${view}-page variant)` : ""}.`,
        mutated: false, // app state only, saved with the document; not part of the PM doc
        summary: summaryOf(),
      };
    }

    case "set_page_setup": {
      const summary = t("aiSumInsertContent");
      const access = app?.pageSetup;
      if (!access) return fail(summary, "page setup is not available here");
      const current = access.read();
      if (current.locked) return fail(summary, "the document is read-only; page setup cannot be changed");
      if (!current.section) return fail(summary, "no page section is available (open a document first)");
      const applyTo = call.input.applyTo === "all" ? "all" : "current";
      const patch: PageSetupPatch = {};
      const done: string[] = [];

      const paper = call.input.paperSize !== undefined ? String(call.input.paperSize) : null;
      if (paper) {
        const size = PAPER_TWIPS[paper];
        if (!size) return fail(summary, 'paperSize must be "letter", "legal" or "a4"');
        patch.paper = size;
        done.push(`paper ${paper}`);
      }
      const orientation = call.input.orientation !== undefined ? String(call.input.orientation) : null;
      if (orientation) {
        if (orientation !== "portrait" && orientation !== "landscape")
          return fail(summary, 'orientation must be "portrait" or "landscape"');
        patch.orientation = orientation;
        done.push(orientation);
      }
      const margins = call.input.margins as Record<string, unknown> | null | undefined;
      if (margins && typeof margins === "object") {
        const m: NonNullable<PageSetupPatch["margins"]> = {};
        for (const [side, key] of [
          ["top", "marginTop"],
          ["right", "marginRight"],
          ["bottom", "marginBottom"],
          ["left", "marginLeft"],
        ] as const) {
          if (margins[side] === undefined || margins[side] === null) continue;
          const inches = Number(margins[side]);
          if (!Number.isFinite(inches) || inches < 0.5 || inches > 2)
            return fail(summary, `margins.${side} must be between 0.5 and 2.0 inches`);
          m[key] = Math.round(inches * TWIPS_PER_INCH);
        }
        if (Object.keys(m).length) {
          patch.margins = m;
          done.push(
            `margins ${(["top", "right", "bottom", "left"] as const)
              .filter((s) => margins[s] !== undefined && margins[s] !== null)
              .map((s) => `${s} ${Number(margins[s])}"`)
              .join(", ")}`,
          );
        }
      }
      if (call.input.columns !== undefined && call.input.columns !== null) {
        const cols = Number(call.input.columns);
        if (!Number.isInteger(cols) || cols < 1 || cols > 3)
          return fail(summary, "columns must be an integer from 1 to 3");
        patch.columns = cols;
        done.push(`${cols} column${cols === 1 ? "" : "s"}`);
      }
      // Preview on the cursor's section: drives validation and the receipt.
      const next = applyPageSetupPatch(current.section, patch);
      if (!done.length) {
        // No fields: report the current layout instead of failing.
        const s = current.section;
        return {
          output: `Current page setup (${current.sectionCount > 1 ? `section ${current.activeSection + 1} of ${current.sectionCount}` : "single section"}): ${s.orientation}, ${twipsToInches(s.pageWidth)}" × ${twipsToInches(s.pageHeight)}", margins T ${twipsToInches(s.marginTop)}" R ${twipsToInches(s.marginRight)}" B ${twipsToInches(s.marginBottom)}" L ${twipsToInches(s.marginLeft)}", ${s.columns} column${s.columns === 1 ? "" : "s"}. Nothing was changed.`,
          mutated: false,
          summary: "Read page setup",
        };
      }
      // Text area must remain usable after the change (Word refuses margins
      // that leave less than about an inch of text width).
      if (next.pageWidth - next.marginLeft - next.marginRight < TWIPS_PER_INCH)
        return fail(summary, "these margins leave no usable text width on the page");
      if (next.pageHeight - next.marginTop - next.marginBottom < TWIPS_PER_INCH)
        return fail(summary, "these margins leave no usable text height on the page");
      const error = access.set(patch, applyTo);
      if (error) return fail(summary, error);
      const where =
        applyTo === "all"
          ? current.sectionCount > 1
            ? `all ${current.sectionCount} sections`
            : "the document"
          : current.sectionCount > 1
            ? `section ${current.activeSection + 1} of ${current.sectionCount}`
            : "the document";
      return {
        output: `Page setup updated for ${where}: ${done.join("; ")}. Now ${next.orientation}, ${twipsToInches(next.pageWidth)}" × ${twipsToInches(next.pageHeight)}", margins T ${twipsToInches(next.marginTop)}" R ${twipsToInches(next.marginRight)}" B ${twipsToInches(next.marginBottom)}" L ${twipsToInches(next.marginLeft)}", ${next.columns} column${next.columns === 1 ? "" : "s"}.`,
        mutated: false, // app-level section state, saved with the document
        summary,
      };
    }

    case "set_table_properties": {
      const summary = t("aiSumInsertContent");
      const idx = Number(call.input.blockIndex);
      const info = docTableAt(editor, idx);
      if (!info)
        return fail(summary, `block ${call.input.blockIndex} is not a table (type "table" in the block list)`);
      const done: string[] = [];
      const rows = info.map.height;
      const cols = info.map.width;

      if (call.input.repeatHeaderRows !== undefined && call.input.repeatHeaderRows !== null) {
        const on = Boolean(call.input.repeatHeaderRows);
        const count = call.input.headerRowCount === undefined ? 1 : Number(call.input.headerRowCount);
        // Turning the repeat OFF needs no header count; only a request to
        // repeat rows is bounded by the table's height.
        if (on && (!Number.isInteger(count) || count < 1 || count >= rows))
          return fail(
            summary,
            rows <= 1
              ? "a one-row table has no body rows to repeat a header over"
              : `headerRowCount must be between 1 and ${rows - 1} for this table`,
          );
        if (setRepeatHeaderRows(editor, idx, on ? count : 0, rows))
          done.push(on ? `first ${count} row${count === 1 ? "" : "s"} repeat on each page` : "header rows no longer repeat");
      }
      const alignment = call.input.alignment !== undefined ? String(call.input.alignment) : null;
      if (alignment) {
        if (!["left", "center", "right"].includes(alignment))
          return fail(summary, 'alignment must be "left", "center" or "right"');
        if (patchTableAttrs(editor, idx, { tblAlign: alignment, tblFloat: null }))
          done.push(`aligned ${alignment}`);
      }
      if (call.input.widthPercent !== undefined && call.input.widthPercent !== null) {
        const pct = Number(call.input.widthPercent);
        if (!Number.isFinite(pct) || pct < 10 || pct > 100)
          return fail(summary, "widthPercent must be between 10 and 100");
        if (patchTableAttrs(editor, idx, { widthPct: pct, widthPx: null, tblAutoFit: "window", tblAutoFitEdited: true }))
          done.push(`width ${pct}%`);
      }
      const autoFit = call.input.autoFit !== undefined ? String(call.input.autoFit) : null;
      if (autoFit) {
        if (autoFit !== "contents" && autoFit !== "window" && autoFit !== "fixed")
          return fail(summary, 'autoFit must be "contents", "window" or "fixed"');
        const contentWidthPx = Math.max(300, editor.view.dom.clientWidth || 0) || 624;
        if (runTableCellCommand(editor, idx, 0, 0, setTableAutoFit(autoFit, contentWidthPx)))
          done.push(`autofit ${autoFit}`);
      }
      const borders = call.input.borders !== undefined ? String(call.input.borders) : null;
      if (borders) {
        if (!BORDER_SCHEMES.has(borders))
          return fail(summary, 'borders must be "all", "outside", "horizontal", "headerRule" or "none"');
        const color = String(call.input.borderColor ?? "000000").replace(/^#/, "");
        if (!/^[0-9a-fA-F]{6}$/.test(color)) return fail(summary, "borderColor must be a 6-digit hex value");
        const widthPt = call.input.borderWidthPt === undefined ? 0.5 : Number(call.input.borderWidthPt);
        if (!Number.isFinite(widthPt) || widthPt < 0.25 || widthPt > 3)
          return fail(summary, "borderWidthPt must be between 0.25 and 3");
        if (applyBorderScheme(editor, idx, borders as BorderScheme, color.toUpperCase(), Math.round(widthPt * 8)))
          done.push(`borders ${borders}`);
      }
      const padding = call.input.cellPadding as Record<string, unknown> | null | undefined;
      if (padding && typeof padding === "object") {
        const current = (info.node.attrs.cellMar as Record<string, number> | null) ?? {};
        const mar: Record<string, number> = { ...current };
        let any = false;
        for (const side of ["top", "right", "bottom", "left"] as const) {
          if (padding[side] === undefined || padding[side] === null) continue;
          const pt = Number(padding[side]);
          if (!Number.isFinite(pt) || pt < 0 || pt > 36) return fail(summary, `cellPadding.${side} must be 0–36 points`);
          mar[side] = Math.round(pt * TWIPS_PER_POINT);
          any = true;
        }
        if (any && patchTableAttrs(editor, idx, { cellMar: mar, cellMarEdited: true })) done.push("cell padding");
      }
      const merge = call.input.mergeCells as Record<string, unknown> | null | undefined;
      if (merge && typeof merge === "object") {
        const r0 = Number(merge.fromRow);
        const c0 = Number(merge.fromCol);
        const r1 = Number(merge.toRow);
        const c1 = Number(merge.toCol);
        if (![r0, c0, r1, c1].every(Number.isInteger) || r0 < 0 || c0 < 0 || r1 >= rows || c1 >= cols || r1 < r0 || c1 < c0)
          return fail(summary, `mergeCells must be a rectangle inside the table (${rows} rows × ${cols} columns, 0-based)`);
        if (r0 === r1 && c0 === c1) return fail(summary, "mergeCells needs at least two cells");
        if (!mergeTableCells(editor, idx, r0, c0, r1, c1))
          return fail(summary, "those cells cannot be merged (the range may cross an existing merged cell)");
        done.push(`merged (${r0},${c0})–(${r1},${c1})`);
      }
      if (!done.length) return fail(summary, "no table property was given, or none applied");
      return {
        output: `Table at block ${idx}: ${done.join("; ")}.${merge ? " The merge changed the cell grid; call get_document_context before further cell edits on this table." : ""}`,
        mutated: true,
        summary,
      };
    }

    case "insert_footnote": {
      const summary = t("aiSumInsertContent");
      const notes = app?.notes;
      if (!notes) return fail(summary, "footnotes are not available here");
      const kind = call.input.kind === "endnote" ? "endnote" : "footnote";
      const afterText = String(call.input.afterText ?? "");
      const noteText = String(call.input.text ?? "").trim();
      if (!afterText.trim()) return fail(summary, "afterText must not be empty");
      if (!noteText) return fail(summary, "text (the note body) must not be empty");
      if (noteText.length > 4000) return fail(summary, "the note text is too long (4000 characters max)");
      const matchCase = call.input.matchCase === undefined ? true : Boolean(call.input.matchCase);
      let matches;
      if (call.input.blockIndex !== undefined && call.input.blockIndex !== null) {
        const bi = Number(call.input.blockIndex);
        if (!Number.isInteger(bi) || bi < 0 || bi >= editor.state.doc.childCount)
          return fail(summary, rangeError(editor));
        const { from } = blockRangePositions(editor, bi, bi);
        matches = findTextMatches(editor.state.doc.child(bi), from, afterText, matchCase);
      } else {
        matches = findTextMatches(editor.state.doc, -1, afterText, matchCase);
      }
      if (!matches.length)
        return fail(summary, `"${afterText.slice(0, 80)}" was not found in the ${call.input.blockIndex !== undefined ? "block" : "document"}; copy the phrase exactly as it appears (search_document shows exact text)`);
      // An ambiguous anchor is refused rather than resolved to the first hit:
      // a note landing after the wrong "Id." is a silent error in a brief.
      const scoped = call.input.blockIndex !== undefined && call.input.blockIndex !== null;
      if (matches.length > 1 && call.input.occurrence === undefined && !scoped)
        return fail(
          summary,
          `"${afterText.slice(0, 80)}" appears ${matches.length} times; pass blockIndex (the paragraph it is in) or occurrence (1-${matches.length}) to say which one gets the note`,
        );
      const occurrence = call.input.occurrence === undefined ? 1 : Number(call.input.occurrence);
      if (!Number.isInteger(occurrence) || occurrence < 1 || occurrence > matches.length)
        return fail(summary, `occurrence must be between 1 and ${matches.length} (${matches.length} match${matches.length === 1 ? "" : "es"} found; pass blockIndex to narrow)`);
      const at = matches[occurrence - 1]!.to;
      const result = notes.insert(kind, noteText, at);
      if (typeof result === "string") return fail(summary, result);
      return {
        output: `Inserted ${kind} ${result.num} after "${afterText.slice(0, 60)}"${matches.length > 1 ? ` (match ${occurrence} of ${matches.length})` : ""}.`,
        mutated: true,
        summary,
      };
    }

    case "check_bluebook_citations": {
      const summary = "Checked Bluebook form";
      let text: string;
      let scopeNote: string;
      if (typeof call.input.text === "string" && call.input.text.trim()) {
        text = call.input.text;
        scopeNote = "the supplied text";
      } else if (Array.isArray(call.input.blockIndexes) && call.input.blockIndexes.length) {
        const idxs = (call.input.blockIndexes as unknown[]).map(Number);
        if (!idxs.every((i) => Number.isInteger(i) && i >= 0 && i < editor.state.doc.childCount))
          return fail(summary, rangeError(editor));
        text = idxs.map((i) => blockPlainText(editor.state.doc.child(i))).join("\n");
        scopeNote = `blocks ${idxs.join(", ")}`;
      } else {
        const parts: string[] = [];
        editor.state.doc.forEach((block) => parts.push(blockPlainText(block)));
        text = parts.join("\n");
        scopeNote = "the whole document";
      }
      const maxFindings = call.input.maxFindings === undefined ? undefined : Number(call.input.maxFindings);
      const report = checkBluebook(text, {
        ...(Number.isInteger(maxFindings) ? { maxFindings: maxFindings as number } : {}),
      });
      return {
        output: JSON.stringify({
          scope: scopeNote,
          summary: report.summary,
          findings: report.findings.map((f) => ({
            severity: f.severity,
            kind: f.kind,
            rule: f.rule,
            found: f.found,
            ...(f.suggestion !== undefined ? { suggestion: f.suggestion } : {}),
            occurrences: f.occurrences,
            message: f.message,
          })),
          citationsScanned: report.citations.length,
          howToFix:
            "For each finding with a suggestion, run apply_commands replaceAllText { containsText: found, replaceText: suggestion, matchCase: true, expectedOccurrences: occurrences }. Findings without a suggestion need the attorney's input (a court or year is missing — never invent one). This checks form only: run verify_citations on any case you have not confirmed.",
        }),
        mutated: false,
        summary,
      };
    }

    case "apply_court_style": {
      const summary = t("aiSumApplyCommands");
      const courtId = call.input.court !== undefined ? String(call.input.court) : "";
      const custom = (call.input.custom ?? null) as Record<string, unknown> | null;
      const profile = courtId ? findCourtStyle(courtId) : null;
      if (courtId && !profile)
        return fail(
          summary,
          `unknown court profile "${courtId}"; available: ${listCourtStyles()
            .map((s) => `${s.id} (${s.label})`)
            .join("; ")}`,
        );
      if (!profile && !custom) return fail(summary, "give a court profile id or custom values");

      const fontFamily = String(custom?.fontFamily ?? profile?.fontFamily ?? "").trim();
      const bodySizePt = Number(custom?.bodySizePt ?? profile?.bodySizePt ?? NaN);
      const lineSpacing = Number(custom?.lineSpacing ?? profile?.lineSpacing ?? NaN);
      // Custom margins override the profile side by side: {top: 1.5} on a
      // profile keeps that profile's other three sides (not 1" defaults).
      const customMargins = (custom?.marginsIn as Record<string, unknown> | undefined) ?? undefined;
      const marginsRaw: Record<string, unknown> = { ...(profile?.marginsIn ?? {}), ...(customMargins ?? {}) };
      if (!fontFamily || fontFamily.length > 64) return fail(summary, "fontFamily is required (1–64 characters)");
      if (!Number.isFinite(bodySizePt) || bodySizePt < 8 || bodySizePt > 18)
        return fail(summary, "bodySizePt must be between 8 and 18");
      if (![1, 1.5, 2].includes(lineSpacing)) return fail(summary, "lineSpacing must be 1, 1.5 or 2");
      const margins = { top: 1, right: 1, bottom: 1, left: 1 };
      for (const side of ["top", "right", "bottom", "left"] as const) {
        const v = Number(marginsRaw[side] ?? 1);
        if (!Number.isFinite(v) || v < 0.5 || v > 2) return fail(summary, `marginsIn.${side} must be 0.5–2.0`);
        margins[side] = v;
      }
      const requirements = profile
        ? describeCourtStyle(profile)
        : `Custom style: ${fontFamily} ${bodySizePt} pt, ${lineSpacing === 2 ? "double" : lineSpacing === 1.5 ? "1.5" : "single"}-spaced, margins T ${margins.top}" R ${margins.right}" B ${margins.bottom}" L ${margins.left}".`;
      if (call.input.dryRun === true) {
        return { output: `Requirements (not applied): ${requirements}`, mutated: false, summary: "Read court style" };
      }

      const notes: string[] = [];
      // 1. Page margins on every section (a filing is one layout throughout).
      const access = app?.pageSetup;
      if (access) {
        const cur = access.read();
        if (cur.locked) return fail(summary, "the document is read-only");
        if (cur.section) {
          const err = access.set(
            {
              margins: {
                marginTop: Math.round(margins.top * TWIPS_PER_INCH),
                marginRight: Math.round(margins.right * TWIPS_PER_INCH),
                marginBottom: Math.round(margins.bottom * TWIPS_PER_INCH),
                marginLeft: Math.round(margins.left * TWIPS_PER_INCH),
              },
            },
            "all",
          );
          if (err) notes.push(`margins not applied: ${err}`);
        } else notes.push("margins not applied: no page section available");
      } else notes.push("margins not applied: page setup is not available here");

      // 2. Typeface and size on every text block; body spacing on paragraphs
      //    and list items (headings stay single-spaced, as every profile allows).
      const styleCmds: Command[] = (["docParagraph", "docListItem", "docHeading"] as const).map((nodeType) => ({
        updateTextStyle: {
          target: { nodeType },
          style: { font: fontFamily, sizeHalfPoints: Math.round(bodySizePt * 2) },
          fields: ["font", "sizeHalfPoints"],
        },
      }));
      // Body spacing skips indented paragraphs (>= 0.5"): block quotations
      // are single-spaced under every profile. Table cells are not top-level
      // blocks, so they are never touched by these commands.
      const bodyParagraphs: number[] = [];
      let quoteBlocks = 0;
      editor.state.doc.forEach((block, _pos, index) => {
        if (block.type.name !== "docParagraph") return;
        if (Number(block.attrs.indentLeft ?? 0) >= 720) quoteBlocks++;
        else bodyParagraphs.push(index);
      });
      const spacingCmds: Command[] = [
        ...(bodyParagraphs.length
          ? [
              {
                updateParagraphStyle: {
                  target: { nodeType: "docParagraph" as const, blockIndexes: bodyParagraphs },
                  style: { lineSpacing },
                  fields: ["lineSpacing"],
                },
              } as Command,
            ]
          : []),
        {
          updateParagraphStyle: {
            target: { nodeType: "docListItem" as const },
            style: { lineSpacing },
            fields: ["lineSpacing"],
          },
        } as Command,
      ];
      const outcome = executeCommands(editor, { commands: [...styleCmds, ...spacingCmds] }, { numIds, track, selection: null });
      if (!outcome.ok) return fail(summary, outcome.error ?? "formatting commands failed");
      const changed = outcome.results.reduce((sum, r) => sum + r.changed, 0);
      if (quoteBlocks) notes.push(`${quoteBlocks} indented paragraph${quoteBlocks === 1 ? "" : "s"} (block quotations) kept their spacing`);
      if (profile && profile.footnoteSizePt !== profile.bodySizePt)
        notes.push(`footnote text should be ${profile.footnoteSizePt} pt (not changed by this tool)`);
      if (profile?.paper === "booklet") notes.push("booklet page size not applied (see profile notes)");
      return {
        output:
          `Applied ${profile ? profile.label : "custom court style"}: ${fontFamily} ${bodySizePt} pt on ${changed} block${changed === 1 ? "" : "s"}, ` +
          `${lineSpacing === 2 ? "double" : lineSpacing === 1.5 ? "1.5" : "single"} spacing on body text, margins T ${margins.top}" R ${margins.right}" B ${margins.bottom}" L ${margins.left}".` +
          (notes.length ? ` Notes: ${notes.join("; ")}.` : "") +
          ` Requirements: ${requirements}`,
        mutated: changed > 0,
        summary,
      };
    }

    case "apply_commands": {
      const commands = call.input.commands;
      if (!Array.isArray(commands) || commands.length === 0) {
        return fail(t("aiSumApplyCommands"), "commands must be a non-empty array");
      }
      const envelope: CommandEnvelope = { commands: commands as Command[] };
      const outcome = executeCommands(editor, envelope, { numIds, track, selection: scope });
      if (!outcome.ok)
        return fail(t("aiSumApplyCommands"), outcome.error ?? "command execution failed");
      const changed = outcome.results.reduce((sum, r) => sum + r.changed, 0);
      const skippedDeleted = outcome.results.reduce((sum, r) => sum + (r.skippedDeleted ?? 0), 0);
      // explicit model-facing note so it stops retrying deletions of already-deleted text
      const deletedNote =
        skippedDeleted > 0
          ? `\nNote: ${skippedDeleted} matched target(s) were skipped because that text is a pending tracked deletion (already struck through). It is not current content — do not try to delete or replace it again; the user accepts/rejects revisions in the Review tab.`
          : "";
      return {
        output: outcome.summary + deletedNote,
        mutated: changed > 0,
        summary: outcome.summary,
      };
    }

    default:
      return fail(call.name, `unknown tool: ${call.name}`);
  }
}

/** Render the document (or a block range) to a PNG the model can look at. */
async function viewPage(editor: Editor, call: AgentToolCall): Promise<ToolExecution> {
  const root = editor.view.dom as HTMLElement;
  const count = editor.state.doc.childCount;
  let clip: { x: number; y: number; width: number; height: number } | undefined;
  let label = "the document from the top";
  const hasRange =
    call.input.startBlockIndex !== undefined || call.input.endBlockIndex !== undefined;
  if (hasRange) {
    const range = validRange(
      editor,
      call.input.startBlockIndex ?? 0,
      call.input.endBlockIndex ?? call.input.startBlockIndex ?? 0,
    );
    if (!range) return fail(t("aiSumReadBlocks"), rangeError(editor));
    const rootRect = root.getBoundingClientRect();
    const first = editor.view.nodeDOM(
      blockRangePositions(editor, range.start, range.start).from,
    ) as HTMLElement | null;
    const last = editor.view.nodeDOM(
      blockRangePositions(editor, range.end, range.end).from,
    ) as HTMLElement | null;
    if (first && last && first.getBoundingClientRect && last.getBoundingClientRect) {
      const a = first.getBoundingClientRect();
      const b = last.getBoundingClientRect();
      clip = {
        x: 0,
        y: Math.max(0, a.top - rootRect.top - 8),
        width: rootRect.width,
        height: Math.max(40, b.bottom - a.top + 16),
      };
      label = `blocks ${range.start}-${range.end}`;
    }
  }
  try {
    const scaleIn = Number(call.input.scale);
    const scale =
      Number.isFinite(scaleIn) && scaleIn > 0 ? Math.min(2, Math.max(0.5, scaleIn)) : 1.25;
    const shot = await captureElement(root, { clip, scale, maxHeightCss: 2400 });
    return {
      output: `Captured ${label} (${shot.width}x${shot.height}px${shot.truncated ? ", cut at the capture height limit; pass a block range for more" : ""}; the document has ${count} blocks). Inspect the attached image.`,
      mutated: false,
      summary: t("aiSumReadDocContext"),
      images: [{ base64: shot.base64, mime: "image/png" }],
      display: {
        kind: "images",
        items: [{ url: `data:image/png;base64,${shot.base64}`, title: `View: ${label}` }],
      },
    };
  } catch (e) {
    return fail(
      t("aiSumReadDocContext"),
      `view_page failed: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
}

/** top-level index of the block containing the caret (doc end as fallback);
 *  a frozen scope wins over the live caret — it is what the prompt described */
function getCursorBlockIndex(editor: Editor, scope?: SelectionScope | null): number {
  if (scope) return Math.min(Math.max(scope.endIndex, 0), editor.state.doc.childCount - 1);
  const { from } = editor.state.selection;
  let result = editor.state.doc.childCount - 1;
  let index = 0;
  editor.state.doc.forEach((node, offset) => {
    if (from >= offset && from <= offset + node.nodeSize) result = index;
    index++;
  });
  return result;
}
