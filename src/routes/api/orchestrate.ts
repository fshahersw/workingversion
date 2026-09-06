// In-house multi-agent litigation research endpoint (SSE).
import { createFileRoute } from "@tanstack/react-router";
import type { HistoryTurn } from "@/lib/agents/orchestration-types";
import { runResearchAgent } from "@/lib/agents/research-agent.server";
import type { Attachment } from "@/lib/chat-types";

function sseHeaders() {
  return {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-store, no-transform",
    Connection: "keep-alive",
  };
}

export const Route = createFileRoute("/api/orchestrate")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        let body: {
          query?: string;
          history?: HistoryTurn[];
          memory?: unknown;
          matter_id?: string;
          matter_label?: string;
          mode?: string;
          attachments?: Attachment[];
        } = {};
        try {
          body = (await request.json()) as typeof body;
        } catch {
          /* empty body */
        }
        const query = (body.query ?? "").trim();
        if (!query) return new Response("query is required", { status: 400 });
        const matterId = (body.matter_id ?? "").trim();
        const matterLabel = (body.matter_label ?? "").trim();
        // "auto" (or anything else) leaves the automatic classifier in charge.
        const forceMode = body.mode === "fast" || body.mode === "think" ? body.mode : undefined;
        const attachments = Array.isArray(body.attachments)
          ? body.attachments.filter((a) => a && typeof a.name === "string" && a.name.length > 0).slice(0, 20)
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
            try {
              await runResearchAgent(
                {
                  query,
                  history: body.history,
                  memory: body.memory,
                  signal: request.signal,
                  ...(forceMode ? { forceMode } : {}),
                  ...(attachments && attachments.length ? { attachments } : {}),
                  ...(matterId
                    ? {
                        matter: {
                          matter_id: matterId,
                          label: matterLabel || matterId,
                        },
                      }
                    : {}),
                },
                emit,
              );
            } catch (err) {
              emit("error", { message: err instanceof Error ? err.message : "Research failed." });
            } finally {
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
