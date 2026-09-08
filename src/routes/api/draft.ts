// Drafts assistant endpoint (SSE). Same event vocabulary as /api/orchestrate
// plus a `proposal` event carrying document material for the editor.
import { createFileRoute } from "@tanstack/react-router";

import { runDraftAgent, type DraftDocumentContext } from "@/lib/agents/draft-agent.server";
import { isDraftMode } from "@/lib/agents/draft-prompts";
import type { HistoryTurn } from "@/lib/agents/orchestration-types";
import type { Attachment } from "@/lib/chat-types";
import { startSseHeartbeat } from "@/lib/sse.server";

const MAX_INSTRUCTION = 8_000;
const MAX_DOC_CHARS = 400_000;

function sseHeaders() {
  return {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-store, no-transform",
    Connection: "keep-alive",
  };
}

function str(v: unknown, max: number): string {
  return typeof v === "string" ? v.slice(0, max) : "";
}

export const Route = createFileRoute("/api/draft")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        let body: {
          mode?: string;
          instruction?: string;
          document?: Partial<DraftDocumentContext>;
          history?: HistoryTurn[];
          memory?: unknown;
          attachments?: Attachment[];
        } = {};
        try {
          body = (await request.json()) as typeof body;
        } catch {
          /* empty body */
        }
        if (!isDraftMode(body.mode)) return new Response("mode is required", { status: 400 });
        const mode = body.mode;
        const instruction = str(body.instruction, MAX_INSTRUCTION).trim();
        if (!instruction && mode !== "edit" && mode !== "review") {
          return new Response("instruction is required", { status: 400 });
        }
        const doc = body.document ?? {};
        const document: DraftDocumentContext = {
          title: str(doc.title, 200),
          text: str(doc.text, MAX_DOC_CHARS),
          ...(doc.selection ? { selection: str(doc.selection, 60_000) } : {}),
          ...(doc.before ? { before: str(doc.before, 4_000) } : {}),
          ...(doc.after ? { after: str(doc.after, 4_000) } : {}),
          ...(doc.style ? { style: str(doc.style, 20) } : {}),
        };
        if (mode === "edit" && !document.selection) {
          return new Response("edit needs a selected passage", { status: 400 });
        }
        const attachments = Array.isArray(body.attachments)
          ? body.attachments
              .filter((a) => a && typeof a.name === "string" && a.name.length > 0)
              .slice(0, 20)
          : undefined;

        const encoder = new TextEncoder();
        const stream = new ReadableStream({
          async start(controller) {
            let closed = false;
            const emit = (event: string, data: unknown) => {
              if (closed) return;
              try {
                controller.enqueue(
                  encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`),
                );
              } catch {
                closed = true;
              }
            };
            const stopHeartbeat = startSseHeartbeat((comment) => {
              if (!closed) controller.enqueue(encoder.encode(comment));
            }, request.signal);
            try {
              await runDraftAgent(
                {
                  mode,
                  instruction,
                  document,
                  history: Array.isArray(body.history) ? body.history.slice(-12) : undefined,
                  memory: body.memory,
                  signal: request.signal,
                  ...(attachments && attachments.length ? { attachments } : {}),
                },
                emit,
              );
            } catch (err) {
              emit("error", {
                message: err instanceof Error ? err.message : "The assistant failed.",
              });
            } finally {
              stopHeartbeat();
              closed = true;
              try {
                controller.close();
              } catch {
                /* already closed */
              }
            }
          },
        });
        return new Response(stream, { headers: sseHeaders() });
      },
    },
  },
});
