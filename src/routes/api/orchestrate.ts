// In-house multi-agent litigation research endpoint (SSE).
import { createFileRoute } from "@tanstack/react-router";
import { type HistoryTurn } from "@/lib/agents/orchestrator.server";
import { runResearchAgent } from "@/lib/agents/research-agent.server";

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
