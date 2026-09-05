import { createFileRoute } from "@tanstack/react-router";

function sseHeaders() {
  return {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-store, no-transform",
    Connection: "keep-alive",
  };
}

export const Route = createFileRoute("/api/pile/session/$id/ask")({
  server: {
    handlers: {
      POST: async ({ request, params }) => {
        let body: { query?: string } = {};
        try {
          body = (await request.json()) as typeof body;
        } catch {
          /* empty */
        }
        const query = (body.query ?? "").trim();
        if (!query) return new Response("query is required", { status: 400 });

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
              const { askPile } = await import("@/lib/pile/ask.server");
              await askPile(params.id, query, emit, request.signal);
            } catch (err) {
              emit("error", {
                message: err instanceof Error ? err.message : "Ask failed.",
              });
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
