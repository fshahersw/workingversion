// ============================================================================
// Platform skill shared by the Writer, Sheets and Slides assistants. The
// editors' own skills edit the open document in the browser; this one adds the
// platform's server-side machinery (Python sandbox, Graphviz, Nova Canvas image
// generation, citation verification, page reading, cross-app document
// creation, firm playbooks) plus browser-only helpers (Mermaid diagrams, the
// clarification card). Images come back as `platform-image:<id>` handles that
// each editor's own insert tool resolves.
// ============================================================================
import type { AgentSkill, AgentToolCall, AgentToolDef, ToolExecution } from "@genoffice/agent-core";

import { askClarification, type ClarifyQuestion } from "./clarify-card";
import { dataUrlOf, describeImage, putPlatformImage, type StoredImage } from "./image-store";

export type PlatformApp = "writer" | "sheets" | "slides";

export type PlatformSkillOptions = {
  app: PlatformApp;
  /** Tool names to leave out (the editor has its own tool under that name). */
  exclude?: readonly string[];
};

/** How the model gets a produced image into the document, per editor. */
const PLACEMENT: Record<PlatformApp, string | null> = {
  writer: "Place it with insert_image, passing this handle as `url`.",
  slides: "Place it with insert_web_image (slideIndex, this handle as `url`, and a pixel frame), or swap an existing picture with replace_image.",
  sheets: null,
};

const CAN_PLACE_IMAGES: Record<PlatformApp, boolean> = { writer: true, slides: true, sheets: false };

function fail(summary: string, output: string): ToolExecution {
  return { output, isError: true, summary };
}

function imageResult(image: StoredImage, summary: string, app: PlatformApp, extra = ""): ToolExecution {
  const placement = PLACEMENT[app];
  const output = [
    `Image ready: ${describeImage(image)}.`,
    placement ?? "This editor cannot embed images; the image is shown to the user in the assistant panel. Describe it briefly.",
    extra,
  ]
    .filter(Boolean)
    .join(" ");
  return {
    output,
    mutated: false,
    summary,
    display: { kind: "images", items: [{ url: dataUrlOf(image), title: image.label }] },
  };
}

function toolDefs(app: PlatformApp): AgentToolDef[] {
  const defs: AgentToolDef[] = [
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
          code: { type: "string", description: "Python 3 source. Keep it self-contained; print results." },
          purpose: { type: "string", description: "One line on what this computes (shown to the user)." },
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
        properties: { text: { type: "string", description: "Text containing one or more citations." } },
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
          maxChars: { type: "integer", description: "Text limit, default 8000, max 20000" },
        },
        required: ["url"],
      },
    },
    {
      name: "load_firm_guide",
      readOnly: true,
      description:
        "Load a Seeger Weiss playbook: firm conventions for a kind of deliverable (citation form, table of authorities, deposition summary, damages tables, MDL status deck, case timeline, firm style). Call with no name to list the guides. Load the relevant guide before drafting or reformatting firm work product.",
      inputSchema: {
        type: "object",
        properties: { name: { type: "string", description: "Guide id from the list, e.g. bluebook-citations" } },
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
            description: "Markdown: #/## headings, - bullets, 1. lists, pipe tables (| a | b |), ```dot blocks for Graphviz diagrams (docx/pdf).",
          },
          style: { type: "string", enum: ["legal", "modern", "minimal"], description: "docx/pdf style, default legal" },
        },
        required: ["kind", "title", "content"],
      },
    },
  ];
  if (CAN_PLACE_IMAGES[app] || app === "sheets") {
    defs.push(
      {
        name: "generate_image",
        description:
          "Generate an image with Amazon Nova Canvas from a text prompt (illustrations, cover art, icons, abstract backgrounds; not for real people or trademarks). Returns an image handle" +
          (CAN_PLACE_IMAGES[app] ? " to place with the editor's insert tool." : "; this editor shows it to the user only."),
        inputSchema: {
          type: "object",
          properties: {
            prompt: { type: "string", description: "Detailed description: subject, style, composition, palette (English)." },
            aspectRatio: { type: "string", enum: ["1:1", "16:9", "9:16", "4:3", "3:4", "3:2", "2:3"], description: "Default 1:1" },
            negativePrompt: { type: "string", description: "What to avoid (text, watermarks, clutter)." },
          },
          required: ["prompt"],
        },
      },
      {
        name: "render_diagram",
        description:
          "Render a diagram to an image: kind 'mermaid' (flowchart, sequence, timeline, gantt, mindmap, class/ER; rendered in the browser) or 'graphviz' (DOT; org charts, dependency and relationship graphs, chronologies with rankdir=LR). Returns an image handle" +
          (CAN_PLACE_IMAGES[app] ? " to place with the editor's insert tool." : "; this editor shows it to the user only.") +
          " Keep labels short; one diagram per call.",
        inputSchema: {
          type: "object",
          properties: {
            kind: { type: "string", enum: ["mermaid", "graphviz"] },
            source: { type: "string", description: "Mermaid or DOT source" },
            title: { type: "string", description: "Short caption used as the image label" },
            engine: { type: "string", enum: ["dot", "neato", "fdp", "sfdp", "circo", "twopi"], description: "Graphviz layout engine, default dot" },
          },
          required: ["kind", "source"],
        },
      },
    );
  }
  return defs;
}

const SYSTEM_PROMPT = `## Platform tools
- run_python: exact arithmetic, date/limitations math, statistics, reshaping data; print results. Use it instead of computing numbers in your head whenever a figure matters.
- render_diagram / generate_image: produce an image handle (platform-image:<id>); place it with the editor's insert tool. Editable native charts and tables are preferred over pictures of them.
- verify_citations: confirm every reporter citation before you rely on it or insert it; report NOT FOUND cites to the user instead of using them.
- fetch_page: read a source web_search surfaced before quoting it.
- load_firm_guide: firm conventions for the deliverable at hand; load the matching guide before drafting firm work product.
- ask_clarification: one card, only when a real ambiguity would change the work; otherwise proceed and state your assumption.
- create_document: a separate Library document (Word, Excel, PowerPoint, PDF) from Markdown; the current document is untouched.`;

export function createPlatformSkill(options: PlatformSkillOptions): AgentSkill {
  const exclude = new Set(options.exclude ?? []);
  const tools = toolDefs(options.app).filter((t) => !exclude.has(t.name));
  const app = options.app;

  const execute = async (call: AgentToolCall, signal?: AbortSignal): Promise<ToolExecution> => {
    const input = call.input;
    switch (call.name) {
      case "run_python": {
        const code = String(input["code"] ?? "");
        if (!code.trim()) return fail("Python", "code must not be empty");
        const purpose = String(input["purpose"] ?? "").trim();
        const { officeRunPythonFn } = await import("@/lib/office/tools.functions");
        const r = await officeRunPythonFn({ data: { code } });
        if (signal?.aborted) return fail("Python", "stopped by the user");
        const images: StoredImage[] = [];
        for (const img of r.images) images.push(await putPlatformImage({ ...img, label: purpose || "Python figure" }));
        const lines = [r.text.trim() || "(no output)"];
        if (images.length) {
          lines.push(
            `Figures produced: ${images.map(describeImage).join("; ")}.`,
            PLACEMENT[app] ?? "This editor cannot embed images; they are shown to the user in the panel.",
          );
        }
        if (r.files.length) lines.push(`Other files written (not embeddable here): ${r.files.map((f) => `${f.name} (${f.size} bytes)`).join(", ")}.`);
        return {
          output: lines.join("\n"),
          isError: r.isError,
          mutated: false,
          summary: purpose ? `Python: ${purpose}` : "Python run",
          ...(images.length
            ? { display: { kind: "images", items: images.map((i) => ({ url: dataUrlOf(i), title: i.label })) } }
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
          const r = await officeFetchPageFn({ data: { url, maxChars: Number(input["maxChars"]) || 8000 } });
          return { output: r.text, mutated: false, summary: `Read ${new URL(url).hostname}` };
        } catch (error) {
          return fail("Read page", `fetch_page failed: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      case "load_firm_guide": {
        const name = String(input["name"] ?? "").trim();
        const { officeGuideFn } = await import("@/lib/office/tools.functions");
        const r = await officeGuideFn({ data: { name } });
        if ("guide" in r && r.guide) return { output: r.guide.body, mutated: false, summary: `Guide: ${r.guide.title}` };
        const list = (r.guides ?? [])
          .filter((g) => g.apps.includes(app))
          .map((g) => `- ${g.id}: ${g.title}. ${g.summary}`)
          .join("\n");
        const prefix = "error" in r && r.error ? `${r.error}\n` : "";
        return { output: `${prefix}Available guides:\n${list}`, mutated: false, summary: "Guides listed" };
      }
      case "ask_clarification": {
        const raw = Array.isArray(input["questions"]) ? (input["questions"] as Record<string, unknown>[]) : [];
        const questions: ClarifyQuestion[] = raw
          .slice(0, 4)
          .map((q, i) => ({
            id: String(q["id"] ?? `q${i + 1}`),
            label: String(q["label"] ?? "").trim(),
            ...(q["description"] ? { description: String(q["description"]) } : {}),
            options: Array.isArray(q["options"]) ? q["options"].map((o) => String(o)).filter(Boolean).slice(0, 5) : [],
            multi: !!q["multi"],
          }))
          .filter((q) => q.label && q.options.length >= 1);
        if (!questions.length) return fail("Ask the user", "questions must be non-empty and each needs options");
        const answer = await askClarification(questions, signal);
        if (answer.cancelled) {
          return {
            output: "The user skipped the questions. Proceed with your best professional judgment and state the assumptions you made.",
            mutated: false,
            summary: "Question skipped",
          };
        }
        return { output: `User answers:\n${answer.answers}\nProceed accordingly.`, mutated: false, summary: "User answered" };
      }
      case "create_document": {
        const kind = String(input["kind"] ?? "docx");
        const title = String(input["title"] ?? "").trim();
        const content = String(input["content"] ?? "");
        if (!title) return fail("Create document", "title must not be empty");
        if (!content.trim()) return fail("Create document", "content must not be empty");
        const { officeCreateDocumentFn } = await import("@/lib/office/tools.functions");
        try {
          const r = await officeCreateDocumentFn({
            data: { kind, title, markdown: content, ...(input["style"] ? { style: String(input["style"]) } : {}) },
          });
          if (r.kind === "pdf") {
            const bytes = Uint8Array.from(atob(r.base64), (c) => c.charCodeAt(0));
            const url = URL.createObjectURL(new Blob([bytes], { type: "application/pdf" }));
            const a = document.createElement("a");
            a.href = url;
            a.download = r.name;
            a.click();
            setTimeout(() => URL.revokeObjectURL(url), 30_000);
            return { output: `Created ${r.name} (${r.size} bytes); the browser downloaded it.`, mutated: false, summary: `Created ${r.name}` };
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
              ...(input["negativePrompt"] ? { negativePrompt: String(input["negativePrompt"]) } : {}),
            },
          });
          if (signal?.aborted) return fail("Generate image", "stopped by the user");
          const image = await putPlatformImage({ mime: r.mime, base64: r.base64, width: r.width, height: r.height, label: prompt.slice(0, 80) });
          return imageResult(image, "Image generated", app);
        } catch (error) {
          return fail("Generate image", error instanceof Error ? error.message : String(error));
        }
      }
      case "render_diagram": {
        const kind = String(input["kind"] ?? "mermaid");
        const source = String(input["source"] ?? "");
        const title = String(input["title"] ?? "").trim() || `${kind} diagram`;
        if (!source.trim()) return fail("Render diagram", "source must not be empty");
        try {
          if (kind === "graphviz") {
            const { officeRenderGraphvizFn } = await import("@/lib/office/tools.functions");
            const r = await officeRenderGraphvizFn({ data: { source, engine: String(input["engine"] ?? "dot") } });
            const image = await putPlatformImage({ mime: r.mime, base64: r.base64, label: title });
            return imageResult(image, `Diagram: ${title}`, app);
          }
          const { renderMermaidPng } = await import("./mermaid-render");
          const r = await renderMermaidPng(source);
          const image = await putPlatformImage({ mime: "image/png", base64: r.base64, width: r.width, height: r.height, label: title });
          return imageResult(image, `Diagram: ${title}`, app);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          return fail("Render diagram", `${kind} render failed: ${message}. Fix the source syntax and call again.`);
        }
      }
      default:
        return fail(call.name, `Unknown tool: ${call.name}`);
    }
  };

  return {
    id: "platform",
    systemPrompt: SYSTEM_PROMPT,
    tools,
    executeTool: (call, signal) => execute(call, signal),
  };
}
