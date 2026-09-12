// ============================================================================
// Platform skill shared by the Writer, Sheets and Slides assistants. The
// editors' own skills edit the open document in the browser; this one adds the
// platform's server-side machinery (Python sandbox, Graphviz, Nova Canvas image
// generation, Stability image editing, citation verification, page reading,
// firm knowledge base and Library search, document templates, cross-app
// document creation, firm playbooks) plus browser-only helpers (Mermaid
// diagrams, the clarification card). Images come back as
// `platform-image:<id>` handles that each editor's own insert tool resolves;
// the produced image is also attached to the tool result so a vision model can
// look at what it made.
// ============================================================================
import type {
  AgentImage,
  AgentSkill,
  AgentToolCall,
  AgentToolDef,
  ToolExecution,
} from "@genoffice/agent-core";

import { askClarification, type ClarifyQuestion } from "./clarify-card";
import {
  dataUrlOf,
  describeImage,
  getPlatformImage,
  isPlatformImage,
  putPlatformImage,
  type StoredImage,
} from "./image-store";

export type PlatformApp = "writer" | "sheets" | "slides";

/** Editor-native template payloads; see src/lib/office/templates.server.ts. */
export type TemplatePayload =
  | { format: "html"; html: string }
  | { format: "ops"; operations: unknown[] }
  | { format: "deck"; deck: unknown };

export type TemplateHooks = {
  /** Apply a template payload to the open document. Return the tool execution the model reads. */
  apply: (
    payload: TemplatePayload,
    template: { id: string; name: string; description: string },
    input: Record<string, unknown>,
  ) => Promise<ToolExecution>;
  /** Capture the open document (or the part the model names) as a reusable template payload. */
  capture?: (input: Record<string, unknown>) => Promise<TemplatePayload>;
};

export type PlatformSkillOptions = {
  app: PlatformApp;
  taskScope?: () => string;
  /** Tool names to leave out (the editor has its own tool under that name). */
  exclude?: readonly string[];
  /** Template application wired by the editor; when absent the template tools are omitted. */
  templates?: TemplateHooks;
};

const KIND: Record<PlatformApp, "docx" | "xlsx" | "pptx"> = {
  writer: "docx",
  sheets: "xlsx",
  slides: "pptx",
};

/** How the model gets a produced image into the document, per editor. */
const PLACEMENT: Record<PlatformApp, string> = {
  writer: "Place it with insert_image, passing this handle as `url`.",
  slides:
    "Place it with insert_web_image (slideIndex, this handle as `url`, and a pixel frame), or swap an existing picture with replace_image.",
  sheets:
    "Place it with propose_operations using {op:'add_image', sheetId, path: <this handle>, anchorCell}.",
};

/** Attach an image to the tool result only when it is small enough to be worth the context. */
const MAX_ATTACH_B64 = 2_500_000;

function fail(summary: string, output: string): ToolExecution {
  return { output, isError: true, summary };
}

function attach(images: StoredImage[]): { images?: AgentImage[] } {
  const small = images.filter((i) => i.base64.length <= MAX_ATTACH_B64).slice(0, 3);
  return small.length ? { images: small.map((i) => ({ base64: i.base64, mime: i.mime })) } : {};
}

function imageResult(
  image: StoredImage,
  summary: string,
  app: PlatformApp,
  extra = "",
): ToolExecution {
  const output = [
    `Image ready: ${describeImage(image)}.`,
    PLACEMENT[app],
    image.diagram
      ? "Editable source is available with get_diagram_source using this handle during this page session."
      : "",
    extra,
  ]
    .filter(Boolean)
    .join(" ");
  return {
    output,
    mutated: false,
    summary,
    display: { kind: "images", items: [{ url: dataUrlOf(image), title: image.label }] },
    ...attach([image]),
  };
}

/** Resolve a `platform-image:` handle or an http(s) URL to base64 for server-side editing. */
async function imageBase64(ref: string): Promise<{ base64: string; mime: string } | null> {
  if (isPlatformImage(ref)) {
    const stored = getPlatformImage(ref);
    return stored ? { base64: stored.base64, mime: stored.mime } : null;
  }
  if (/^https?:\/\//i.test(ref)) {
    const { officeFetchImageFn } = await import("@/lib/office/tools.functions");
    const r = await officeFetchImageFn({ data: { url: ref } });
    return { base64: r.base64, mime: r.mime };
  }
  const raw: string = ref;
  if (/^data:image\/(png|jpeg);base64,/i.test(raw)) {
    const comma = raw.indexOf(",");
    return { base64: raw.slice(comma + 1), mime: raw.slice(5, raw.indexOf(";")) };
  }
  return null;
}

function toolDefs(app: PlatformApp, withTemplates: boolean): AgentToolDef[] {
  const defs: AgentToolDef[] = [
    {
      name: "load_attachment_for_python",
      description:
        "Load an original Office/PDF attachment into this task's Python workspace. Pass the source handle returned by read_attachment. The result contains the exact filename to use with pandas/openpyxl/python-docx/pdfplumber. Call once per needed file per task. Plain-text inputs read locally can instead be supplied directly to Python.",
      inputSchema: {
        type: "object",
        properties: { handle: { type: "string" } },
        required: ["handle"],
      },
    },
    {
      name: "get_diagram_source",
      readOnly: true,
      description:
        "Read the editable source and rendering settings of a diagram created during this page session. Use before revising its labels, relationships or layout, then render_diagram again and replace the original image using the editor tools. Source handles expire when the page is closed.",
      inputSchema: {
        type: "object",
        properties: { handle: { type: "string" } },
        required: ["handle"],
      },
    },
    {
      name: "run_python",
      description:
        "Run Python in a secure sandbox (pandas, numpy, matplotlib, openpyxl, python-docx, graphviz preinstalled; no network) for exact calculations, date math, statistics, data reshaping or a matplotlib figure. Print what you need to read back. Figures saved as PNG (plt.savefig) or shown (plt.show) come back as images. Prefer the editor's native chart tools for charts that must stay editable; use a figure only when a native chart cannot express it." +
        (app === "sheets"
          ? " For workbook data, read it with read_range first, compute here, then write results back with propose_operations."
          : ""),
      inputSchema: {
        type: "object",
        properties: {
          code: {
            type: "string",
            description: "Python 3 source. Keep it self-contained; print results.",
          },
          purpose: {
            type: "string",
            description: "One line on what this computes (shown to the user).",
          },
        },
        required: ["code"],
      },
    },
    {
      name: "verify_citations",
      readOnly: true,
      description:
        "Check reporter citations (509 U.S. 579, 2023 WL 12345, 43 F.4th 1) against CourtListener's opinion database. Returns CONFIRMED with the case name, AMBIGUOUS, or NOT FOUND per cite. Run this before relying on or inserting any case citation; never present a NOT FOUND cite as authority.",
      inputSchema: {
        type: "object",
        properties: {
          text: { type: "string", description: "Text containing one or more citations." },
        },
        required: ["text"],
      },
    },
    {
      name: "fetch_page",
      readOnly: true,
      description:
        "Read a public web page in full (article, opinion, agency rule, court page) from a URL, typically one web_search surfaced. Reading the page beats reasoning from a snippet. Returns title and extracted text.",
      inputSchema: {
        type: "object",
        properties: {
          url: { type: "string", description: "http(s) URL" },
          maxChars: { type: "integer", description: "Text limit, default 12000, max 60000" },
        },
        required: ["url"],
      },
    },
    {
      name: "search_firm_knowledge",
      readOnly: true,
      description:
        "Semantic search across the firm's knowledge base workspaces (uploaded matter documents, depositions, expert reports, pleadings, research) that the user has access to. Returns the best passages with workspace, document and page references. Use it when the user refers to case facts, prior work, or 'our documents'; cite the document and page in the draft. Pass workspace to narrow to one matter (name or id) once you know it.",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "Natural-language question or key facts to find." },
          workspace: {
            type: "string",
            description: "Optional workspace name or id to restrict the search.",
          },
          topK: { type: "integer", description: "Passages to return, default 8, max 24." },
        },
        required: ["query"],
      },
    },
    {
      name: "search_library",
      readOnly: true,
      description:
        "List or search the user's Office Library (their Word, Excel and PowerPoint documents on this platform) by name. Returns name, kind, last update and an open link. Use it to find a related deliverable to reference or to give the user a link; use create_document to make a new one.",
      inputSchema: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "Words from the document name; omit to list recent documents.",
          },
          kind: {
            type: "string",
            enum: ["docx", "xlsx", "pptx"],
            description: "Restrict to one kind.",
          },
          limit: { type: "integer", description: "Default 20, max 50." },
        },
        required: [],
      },
    },
    {
      name: "load_firm_guide",
      readOnly: true,
      description:
        "Load a Seeger Weiss playbook: firm conventions for a kind of deliverable (citation form, table of authorities, deposition summary, damages tables, MDL status deck, case timeline, firm style). Call with no name to list the guides. Load the relevant guide before drafting or reformatting firm work product.",
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string", description: "Guide id from the list, e.g. bluebook-citations" },
        },
        required: [],
      },
    },
    {
      name: "ask_clarification",
      description:
        "Show the user a card with one to four questions, each with two to five options (the card adds an 'Other' field). Use it only when the request is ambiguous in a way that changes the work materially (audience, scope, which of several tables, tone), at most once per request, and never for details you can infer from the document. Wait for the answers, then proceed. Do not repeat the questions in your reply.",
      inputSchema: {
        type: "object",
        properties: {
          questions: {
            type: "array",
            description: "1-4 questions",
            items: {
              type: "object",
              properties: {
                id: { type: "string" },
                label: { type: "string", description: "The question" },
                description: { type: "string", description: "Optional one-line note" },
                options: { type: "array", items: { type: "string" }, description: "2-5 options" },
                multi: { type: "boolean", description: "Allow several answers" },
              },
              required: ["id", "label", "options"],
            },
          },
        },
        required: ["questions"],
      },
    },
    {
      name: "create_document",
      description:
        "Create a new document in the user's Library from Markdown and return a link to open it: kind docx (Word memo/letter, legal style), xlsx (tables become sheets), pptx (each `#`/`##` heading becomes a slide, list items become bullets; opens in Slides, fully editable), or pdf (download). Use when the user asks for a separate deliverable, e.g. a summary deck from this memo. The current document is not changed.",
      inputSchema: {
        type: "object",
        properties: {
          kind: { type: "string", enum: ["docx", "xlsx", "pptx", "pdf"] },
          title: { type: "string" },
          content: {
            type: "string",
            description:
              "Markdown: #/## headings, - bullets, 1. lists, pipe tables (| a | b |), ```dot blocks for Graphviz diagrams (docx/pdf).",
          },
          style: {
            type: "string",
            enum: ["legal", "modern", "minimal"],
            description: "docx/pdf style, default legal",
          },
        },
        required: ["kind", "title", "content"],
      },
    },
    {
      name: "generate_image",
      description:
        "Generate an image with Amazon Nova Canvas from a text prompt (illustrations, cover art, icons, abstract backgrounds; not for real people or trademarks). Returns an image handle to place with the editor's insert tool, and shows you the image so you can judge it.",
      inputSchema: {
        type: "object",
        properties: {
          prompt: {
            type: "string",
            description: "Detailed description: subject, style, composition, palette (English).",
          },
          aspectRatio: {
            type: "string",
            enum: ["1:1", "16:9", "9:16", "4:3", "3:4", "3:2", "2:3"],
            description: "Default 1:1",
          },
          negativePrompt: {
            type: "string",
            description: "What to avoid (text, watermarks, clutter).",
          },
        },
        required: ["prompt"],
      },
    },
    {
      name: "edit_image",
      description:
        "Edit an existing image (a platform-image handle from generate_image/render_diagram/run_python, or an http(s) URL) with the Stability AI suite on Bedrock: remove_background (transparent PNG), search_replace (searchPrompt names the object, prompt describes its replacement), recolor (searchPrompt names the object, prompt gives the new color), erase (mask or searchPrompt), inpaint (mask + prompt), outpaint (expand {left,right,up,down} pixels, optional prompt), style_guide / style_transfer (styleImage handle), sketch / structure (prompt + strength 0-1, use the image as guidance), upscale_fast / upscale_conservative / upscale_creative. Returns a new image handle and shows you the result.",
      inputSchema: {
        type: "object",
        properties: {
          operation: {
            type: "string",
            enum: [
              "remove_background",
              "search_replace",
              "recolor",
              "erase",
              "inpaint",
              "outpaint",
              "style_guide",
              "style_transfer",
              "sketch",
              "structure",
              "upscale_fast",
              "upscale_conservative",
              "upscale_creative",
            ],
          },
          image: {
            type: "string",
            description: "platform-image:<id> handle or http(s) URL of the image to edit",
          },
          prompt: {
            type: "string",
            description:
              "What to produce (replacement, new color, expansion content, style target).",
          },
          searchPrompt: {
            type: "string",
            description: "What to find in the image (search_replace, recolor, erase).",
          },
          negativePrompt: { type: "string" },
          mask: {
            type: "string",
            description: "Optional mask image handle (white = edit) for erase/inpaint.",
          },
          styleImage: {
            type: "string",
            description: "Style reference image handle (style_guide, style_transfer).",
          },
          expand: {
            type: "object",
            properties: {
              left: { type: "integer" },
              right: { type: "integer" },
              up: { type: "integer" },
              down: { type: "integer" },
            },
            description: "Pixels to add per side (outpaint).",
          },
          strength: {
            type: "number",
            description: "0-1 guidance strength (sketch, structure, style_transfer).",
          },
          label: { type: "string", description: "Short label for the resulting image." },
        },
        required: ["operation", "image"],
      },
    },
    {
      name: "render_diagram",
      description:
        "Render a diagram to an image: kind 'mermaid' (flowchart, sequence, timeline, gantt, mindmap, quadrant, pie, xychart, sankey, state, journey, class/ER; rendered in the browser) or 'graphviz' (DOT; org charts, dependency and relationship graphs, chronologies with rankdir=LR). Returns an image handle to place with the editor's insert tool and shows you the rendering so you can check labels and layout. Keep labels short; one diagram per call.",
      inputSchema: {
        type: "object",
        properties: {
          kind: { type: "string", enum: ["mermaid", "graphviz"] },
          source: { type: "string", description: "Mermaid or DOT source" },
          title: { type: "string", description: "Short caption used as the image label" },
          engine: {
            type: "string",
            enum: ["dot", "neato", "fdp", "sfdp", "circo", "twopi"],
            description: "Graphviz layout engine, default dot",
          },
          theme: {
            type: "string",
            enum: ["default", "neutral", "forest", "dark", "base"],
            description: "Mermaid theme, default neutral",
          },
        },
        required: ["kind", "source"],
      },
    },
  ];
  if (withTemplates) {
    const kind = KIND[app];
    defs.push(
      {
        name: "list_templates",
        readOnly: true,
        description: `List the ${kind} templates available to this editor: firm templates (memos, letters, briefs, trackers, decks) and the user's saved templates. Returns id, name, category and description. Call before apply_template when the user asks for a template, a standard format, or "the usual" layout.`,
        inputSchema: { type: "object", properties: {}, required: [] },
      },
      {
        name: "apply_template",
        description:
          `Apply a ${kind} template by id to the open document: ` +
          (app === "writer"
            ? "its structure is inserted at the cursor (or replaces the document when replace=true) with [Bracketed] placeholders. Then fill the placeholders from the user's facts with the editing tools."
            : app === "sheets"
              ? "its layout (headers, widths, formats, formulas) is proposed as operations on the active sheet (or a new sheet when newSheetName is given). Then fill the data with propose_operations."
              : "its slides are built natively in the deck (appended, or replacing the deck when replace=true) with [Bracketed] placeholders. Then fill the placeholders with the slide editing tools."),
        inputSchema: {
          type: "object",
          properties: {
            id: { type: "string", description: "Template id from list_templates" },
            replace: {
              type: "boolean",
              description: "Replace the current content instead of adding to it (writer, slides).",
            },
            newSheetName: {
              type: "string",
              description: "Sheets: build the template on a new sheet with this name.",
            },
          },
          required: ["id"],
        },
      },
    );
    defs.push({
      name: "save_template",
      description: `Save the current ${kind} document${app === "sheets" ? "'s active sheet layout" : app === "slides" ? "'s slides" : ""} as a reusable template in the user's template list (structure, formatting and any text left in place). Use when the user asks to keep this as a template or reuse this format later.`,
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string", description: "Template name" },
          description: { type: "string", description: "One line on when to use it" },
          category: { type: "string", description: "Grouping label, e.g. Memos, Discovery, Trial" },
        },
        required: ["name"],
      },
    });
  }
  return defs;
}

const SYSTEM_PROMPT = `## Platform tools
- run_python: exact arithmetic, date/limitations math, statistics, reshaping data; print results. Use it instead of computing numbers in your head whenever a figure matters.
- render_diagram / generate_image / edit_image: produce an image handle (platform-image:<id>) and show you the image; look at it, fix problems (cut-off labels, wrong colors) with another call, then place it with the editor's insert tool. Editable native charts and tables are preferred over pictures of them.
- verify_citations: confirm every reporter citation before you rely on it or insert it; report NOT FOUND cites to the user instead of using them.
- search_firm_knowledge: the firm's knowledge base (matter documents, depositions, expert reports). Use it when the user refers to case facts or prior work; cite document and page.
- search_library: the user's own Office documents on this platform, with open links.
- fetch_page: read a source web_search surfaced before quoting it.
- load_firm_guide: firm conventions for the deliverable at hand; load the matching guide before drafting firm work product.
- list_templates / apply_template / save_template: start from a firm or saved template when the user wants a standard deliverable; apply it first, then fill the [Bracketed] placeholders from the user's facts.
- ask_clarification: one card, only when a real ambiguity would change the work; otherwise proceed and state your assumption.
- create_document: a separate Library document (Word, Excel, PowerPoint, PDF) from Markdown; the current document is untouched.`;

export function createPlatformSkill(options: PlatformSkillOptions): AgentSkill {
  const exclude = new Set(options.exclude ?? []);
  const tools = toolDefs(options.app, !!options.templates).filter((t) => !exclude.has(t.name));
  let taskScope = crypto.randomUUID() as string;
  const app = options.app;
  const kind = KIND[app];

  const execute = async (call: AgentToolCall, signal?: AbortSignal): Promise<ToolExecution> => {
    const taskId = options.taskScope?.() ?? taskScope;
    const input = call.input;
    switch (call.name) {
      case "load_attachment_for_python": {
        const { officeStageAttachmentFn } = await import("@/lib/office/tools.functions");
        const r = await officeStageAttachmentFn({
          data: { handle: String(input["handle"] ?? ""), taskId },
        });
        return { output: JSON.stringify(r), mutated: false, summary: "Attachment ready in Python" };
      }
      case "get_diagram_source": {
        const image = getPlatformImage(String(input["handle"] ?? ""));
        if (!image?.diagram)
          return fail(
            "Diagram source",
            "This handle has no saved diagram source in this page session.",
          );
        const { svg: _svg, ...settings } = image.diagram;
        return {
          output: JSON.stringify({ title: image.label, ...settings }),
          mutated: false,
          summary: "Read editable diagram source",
        };
      }
      case "run_python": {
        const code = String(input["code"] ?? "");
        if (!code.trim()) return fail("Python", "code must not be empty");
        const purpose = String(input["purpose"] ?? "").trim();
        const { officeRunPythonFn } = await import("@/lib/office/tools.functions");
        const r = await officeRunPythonFn({ data: { code, taskId } });
        if (signal?.aborted) return fail("Python", "stopped by the user");
        const images: StoredImage[] = [];
        for (const img of r.images)
          images.push(await putPlatformImage({ ...img, label: purpose || "Python figure" }));
        const lines = [r.text.trim() || "(no output)"];
        if (images.length)
          lines.push(`Figures produced: ${images.map(describeImage).join("; ")}.`, PLACEMENT[app]);
        if (r.files.length)
          lines.push(
            `Other files written (not embeddable here): ${r.files.map((f) => `${f.name} (${f.size} bytes)`).join(", ")}.`,
          );
        return {
          output: lines.join("\n"),
          isError: r.isError,
          mutated: false,
          summary: purpose ? `Python: ${purpose}` : "Python run",
          ...(images.length
            ? {
                display: {
                  kind: "images",
                  items: images.map((i) => ({ url: dataUrlOf(i), title: i.label })),
                },
                ...attach(images),
              }
            : {}),
        };
      }
      case "verify_citations": {
        const text = String(input["text"] ?? "");
        if (text.trim().length < 3) return fail("Verify citations", "text must contain a citation");
        const { officeVerifyCitationsFn } = await import("@/lib/office/tools.functions");
        const r = await officeVerifyCitationsFn({ data: { text } });
        return { output: r.text, mutated: false, summary: "Citations checked" };
      }
      case "fetch_page": {
        const url = String(input["url"] ?? "");
        if (!/^https?:\/\//i.test(url)) return fail("Read page", "url must be an http(s) URL");
        const { officeFetchPageFn } = await import("@/lib/office/tools.functions");
        try {
          const r = await officeFetchPageFn({
            data: { url, maxChars: Number(input["maxChars"]) || 12_000 },
          });
          return { output: r.text, mutated: false, summary: `Read ${new URL(url).hostname}` };
        } catch (error) {
          return fail(
            "Read page",
            `fetch_page failed: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
      case "search_firm_knowledge": {
        const query = String(input["query"] ?? "").trim();
        if (!query) return fail("Firm knowledge", "query must not be empty");
        const { officeSearchKnowledgeFn } = await import("@/lib/office/tools.functions");
        try {
          const r = await officeSearchKnowledgeFn({
            data: {
              query,
              ...(input["workspace"] ? { workspace: String(input["workspace"]) } : {}),
              ...(Number.isFinite(Number(input["topK"])) && input["topK"]
                ? { topK: Number(input["topK"]) }
                : {}),
            },
          });
          if (!r.available.length) {
            return {
              output:
                "The user has no knowledge base workspaces yet. Suggest uploading matter documents to the Knowledge page.",
              mutated: false,
              summary: "No workspaces",
            };
          }
          if (!r.hits.length) {
            return {
              output: `No passages matched in ${r.searched.join(", ") || "the available workspaces"}. Workspaces available: ${r.available.join(", ")}. Try different terms or name a workspace.`,
              mutated: false,
              summary: "No matches",
            };
          }
          const lines = r.hits.map(
            (h, i) =>
              `[${i + 1}] ${h.workspace} / ${h.document}${h.pages ? ` (p. ${h.pages})` : ""} (score ${h.score.toFixed(2)})\n${h.snippet}`,
          );
          return {
            output: `Searched: ${r.searched.join(", ")}.\n\n${lines.join("\n\n")}`,
            mutated: false,
            summary: `Firm knowledge: ${r.hits.length} passage${r.hits.length === 1 ? "" : "s"}`,
          };
        } catch (error) {
          return fail("Firm knowledge", error instanceof Error ? error.message : String(error));
        }
      }
      case "search_library": {
        const { officeSearchLibraryFn } = await import("@/lib/office/tools.functions");
        try {
          const r = await officeSearchLibraryFn({
            data: {
              ...(input["query"] ? { query: String(input["query"]) } : {}),
              ...(input["kind"] ? { kind: String(input["kind"]) } : {}),
              ...(input["limit"] ? { limit: Number(input["limit"]) } : {}),
            },
          });
          if (!r.docs.length)
            return {
              output: "No matching documents in the Library.",
              mutated: false,
              summary: "Library: none",
            };
          const items = r.docs.map((d) => ({ url: `${location.origin}${d.url}`, title: d.name }));
          const lines = r.docs.map(
            (d) =>
              `- ${d.name} (${d.kind}, updated ${d.updatedAt.slice(0, 10)}): ${location.origin}${d.url}`,
          );
          return {
            output: lines.join("\n"),
            mutated: false,
            summary: `Library: ${r.docs.length} document${r.docs.length === 1 ? "" : "s"}`,
            display: { kind: "links", items },
          };
        } catch (error) {
          return fail("Library", error instanceof Error ? error.message : String(error));
        }
      }
      case "load_firm_guide": {
        const name = String(input["name"] ?? "").trim();
        const { officeGuideFn } = await import("@/lib/office/tools.functions");
        const r = await officeGuideFn({ data: { name } });
        if ("guide" in r && r.guide)
          return { output: r.guide.body, mutated: false, summary: `Guide: ${r.guide.title}` };
        const list = (r.guides ?? [])
          .filter((g) => g.apps.includes(app))
          .map((g) => `- ${g.id}: ${g.title}. ${g.summary}`)
          .join("\n");
        const prefix = "error" in r && r.error ? `${r.error}\n` : "";
        return {
          output: `${prefix}Available guides:\n${list}`,
          mutated: false,
          summary: "Guides listed",
        };
      }
      case "list_templates": {
        const { officeListTemplatesFn } = await import("@/lib/office/tools.functions");
        try {
          const r = await officeListTemplatesFn({ data: { kind } });
          if (!r.templates.length)
            return {
              output: "No templates available.",
              mutated: false,
              summary: "Templates: none",
            };
          const lines = r.templates.map(
            (t) =>
              `- ${t.id} [${t.source === "mine" ? "saved" : "firm"} | ${t.category}] ${t.name}: ${t.description}`,
          );
          return {
            output: lines.join("\n"),
            mutated: false,
            summary: `${r.templates.length} templates`,
          };
        } catch (error) {
          return fail("Templates", error instanceof Error ? error.message : String(error));
        }
      }
      case "apply_template": {
        if (!options.templates)
          return fail("Apply template", "Templates are not available in this editor.");
        const id = String(input["id"] ?? "").trim();
        if (!id) return fail("Apply template", "id is required; call list_templates first");
        const { officeGetTemplateFn } = await import("@/lib/office/tools.functions");
        try {
          const t = await officeGetTemplateFn({ data: { kind, id } });
          const payload = t.payload as TemplatePayload;
          if (!payload || typeof payload !== "object" || !("format" in payload))
            return fail("Apply template", "The template payload is unreadable.");
          return await options.templates.apply(
            payload,
            { id: t.id, name: t.name, description: t.description },
            input,
          );
        } catch (error) {
          return fail("Apply template", error instanceof Error ? error.message : String(error));
        }
      }
      case "save_template": {
        if (!options.templates?.capture)
          return fail("Save template", "Saving templates is not available in this editor.");
        const name = String(input["name"] ?? "").trim();
        if (!name) return fail("Save template", "name is required");
        try {
          const payload = await options.templates.capture(input);
          const { officeSaveTemplateFn } = await import("@/lib/office/tools.functions");
          const r = await officeSaveTemplateFn({
            data: {
              kind,
              name,
              ...(input["description"] ? { description: String(input["description"]) } : {}),
              ...(input["category"] ? { category: String(input["category"]) } : {}),
              payload,
            },
          });
          return {
            output: `Saved template "${r.name}" (id ${r.id}). It will appear in list_templates under "${r.category}".`,
            mutated: false,
            summary: `Template saved: ${r.name}`,
          };
        } catch (error) {
          return fail("Save template", error instanceof Error ? error.message : String(error));
        }
      }
      case "ask_clarification": {
        const raw = Array.isArray(input["questions"])
          ? (input["questions"] as Record<string, unknown>[])
          : [];
        const questions: ClarifyQuestion[] = raw
          .slice(0, 4)
          .map((q, i) => ({
            id: String(q["id"] ?? `q${i + 1}`),
            label: String(q["label"] ?? "").trim(),
            ...(q["description"] ? { description: String(q["description"]) } : {}),
            options: Array.isArray(q["options"])
              ? q["options"]
                  .map((o) => String(o))
                  .filter(Boolean)
                  .slice(0, 5)
              : [],
            multi: !!q["multi"],
          }))
          .filter((q) => q.label && q.options.length >= 1);
        if (!questions.length)
          return fail("Ask the user", "questions must be non-empty and each needs options");
        const answer = await askClarification(questions, signal);
        if (answer.cancelled) {
          return {
            output:
              "The user skipped the questions. Proceed with your best professional judgment and state the assumptions you made.",
            mutated: false,
            summary: "Question skipped",
          };
        }
        return {
          output: `User answers:\n${answer.answers}\nProceed accordingly.`,
          mutated: false,
          summary: "User answered",
        };
      }
      case "create_document": {
        const docKind = String(input["kind"] ?? "docx");
        const title = String(input["title"] ?? "").trim();
        const content = String(input["content"] ?? "");
        if (!title) return fail("Create document", "title must not be empty");
        if (!content.trim()) return fail("Create document", "content must not be empty");
        const { officeCreateDocumentFn } = await import("@/lib/office/tools.functions");
        try {
          const r = await officeCreateDocumentFn({
            data: {
              taskId,
              kind: docKind,
              title,
              markdown: content,
              ...(input["style"] ? { style: String(input["style"]) } : {}),
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
              output: `Created ${r.name} (${r.size} bytes); the browser downloaded it.`,
              mutated: false,
              summary: `Created ${r.name}`,
            };
          }
          const href = `${location.origin}${r.url}`;
          return {
            output: `Created "${r.doc.name}" in the Library. Open it at ${href} . Tell the user the document is ready and give this link.`,
            mutated: false,
            summary: `Created ${r.doc.name}`,
            display: { kind: "links", items: [{ url: href, title: r.doc.name }] },
          };
        } catch (error) {
          return fail("Create document", error instanceof Error ? error.message : String(error));
        }
      }
      case "generate_image": {
        const prompt = String(input["prompt"] ?? "").trim();
        if (!prompt) return fail("Generate image", "prompt must not be empty");
        const { officeGenerateImageFn } = await import("@/lib/office/tools.functions");
        try {
          const r = await officeGenerateImageFn({
            data: {
              prompt,
              ...(input["aspectRatio"] ? { aspectRatio: String(input["aspectRatio"]) } : {}),
              ...(input["negativePrompt"]
                ? { negativePrompt: String(input["negativePrompt"]) }
                : {}),
            },
          });
          if (signal?.aborted) return fail("Generate image", "stopped by the user");
          const image = await putPlatformImage({
            mime: r.mime,
            base64: r.base64,
            width: r.width,
            height: r.height,
            label: prompt.slice(0, 80),
          });
          return imageResult(image, "Image generated", app);
        } catch (error) {
          return fail("Generate image", error instanceof Error ? error.message : String(error));
        }
      }
      case "edit_image": {
        const operation = String(input["operation"] ?? "").trim();
        const ref = String(input["image"] ?? "").trim();
        if (!operation) return fail("Edit image", "operation is required");
        if (!ref)
          return fail("Edit image", "image is required (platform-image handle or http(s) URL)");
        try {
          const source = await imageBase64(ref);
          if (!source)
            return fail(
              "Edit image",
              `Unknown image reference ${ref}. Use a platform-image:<id> handle from an earlier tool result or an http(s) URL.`,
            );
          const mask = input["mask"] ? await imageBase64(String(input["mask"])) : null;
          const styleImage = input["styleImage"]
            ? await imageBase64(String(input["styleImage"]))
            : null;
          const { officeEditImageFn } = await import("@/lib/office/tools.functions");
          const r = await officeEditImageFn({
            data: {
              operation,
              image: source.base64,
              ...(input["prompt"] ? { prompt: String(input["prompt"]) } : {}),
              ...(input["searchPrompt"] ? { searchPrompt: String(input["searchPrompt"]) } : {}),
              ...(input["negativePrompt"]
                ? { negativePrompt: String(input["negativePrompt"]) }
                : {}),
              ...(mask ? { mask: mask.base64 } : {}),
              ...(styleImage ? { styleImage: styleImage.base64 } : {}),
              ...(input["expand"] && typeof input["expand"] === "object"
                ? { expand: input["expand"] as Record<string, number> }
                : {}),
              ...(Number.isFinite(Number(input["strength"])) && input["strength"] !== undefined
                ? { strength: Number(input["strength"]) }
                : {}),
            },
          });
          if (signal?.aborted) return fail("Edit image", "stopped by the user");
          const label =
            String(input["label"] ?? "").trim() || `${operation.replace(/_/g, " ")} result`;
          const image = await putPlatformImage({
            mime: r.mime,
            base64: r.base64,
            width: r.width,
            height: r.height,
            label,
          });
          return imageResult(image, `Image edited: ${operation.replace(/_/g, " ")}`, app);
        } catch (error) {
          return fail("Edit image", error instanceof Error ? error.message : String(error));
        }
      }
      case "render_diagram": {
        const diagramKind = String(input["kind"] ?? "mermaid");
        const source = String(input["source"] ?? "");
        const title = String(input["title"] ?? "").trim() || `${diagramKind} diagram`;
        if (!source.trim()) return fail("Render diagram", "source must not be empty");
        try {
          if (diagramKind === "graphviz") {
            const { officeRenderGraphvizFn } = await import("@/lib/office/tools.functions");
            const r = await officeRenderGraphvizFn({
              data: { source, taskId, engine: String(input["engine"] ?? "dot") },
            });
            const image = await putPlatformImage({
              mime: r.mime,
              base64: r.base64,
              label: title,
              diagram: { kind: "graphviz", source, engine: String(input["engine"] ?? "dot") },
            });
            return imageResult(image, `Diagram: ${title}`, app);
          }
          const { renderMermaidPng } = await import("./mermaid-render");
          const r = await renderMermaidPng(source, {
            theme: input["theme"] ? String(input["theme"]) : undefined,
          });
          const image = await putPlatformImage({
            mime: "image/png",
            base64: r.base64,
            width: r.width,
            height: r.height,
            label: title,
            diagram: {
              kind: "mermaid",
              source,
              theme: String(input["theme"] ?? "neutral"),
              svg: r.svg,
            },
          });
          return imageResult(image, `Diagram: ${title}`, app);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          return fail(
            "Render diagram",
            `${diagramKind} render failed: ${message}. Fix the source syntax and call again.`,
          );
        }
      }
      default:
        return fail(call.name, `Unknown tool: ${call.name}`);
    }
  };

  return {
    id: "platform",
    buildContext: () => {
      taskScope = crypto.randomUUID();
      return "Python uses a fresh workspace for this task. Files and variables persist across tool calls in this task only; do not assume earlier tasks left files behind.";
    },
    systemPrompt: SYSTEM_PROMPT,
    tools,
    executeTool: (call, signal) => execute(call, signal),
  };
}
