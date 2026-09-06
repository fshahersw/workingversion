import { createFileRoute } from "@tanstack/react-router";

import { startSseHeartbeat } from "@/lib/sse.server";

// Saved-workspace Ask: resolve the authenticated DynamoDB workspace, retrieve
// reranked Aurora chunks, then stream the existing Working Set answer events.
// Gated by apiAuthMiddleware; principal is derived here and never from the body.

function sseHeaders() {
  return {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-store, no-transform",
    Connection: "keep-alive",
  };
}

type Body = {
  itemId?: string;
  query?: string;
  docIds?: string[];
  sourceChunkIds?: number[];
  instructions?: string | null;
  prior?: { query?: string; answer?: string };
};

export const Route = createFileRoute("/api/kb/ask")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const { getUserFromRequest } = await import("@/lib/auth/cognito.server");
        const user = await getUserFromRequest(request);
        if (!user) return Response.json({ error: "unauthorized" }, { status: 401 });

        let body: Body;
        try {
          body = (await request.json()) as Body;
        } catch {
          return Response.json({ error: "invalid JSON" }, { status: 400 });
        }
        const itemId = String(body.itemId ?? "").trim();
        const query = String(body.query ?? "").trim();
        if (!itemId || !query) {
          return Response.json({ error: "itemId and query are required" }, { status: 400 });
        }

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
              const { askSavedWorkspace } = await import("@/lib/kb/ask.server");
              await askSavedWorkspace(
                user.sub,
                {
                  itemId,
                  query: query.slice(0, 4000),
                  ...(Array.isArray(body.docIds)
                    ? { docIds: body.docIds.map(String).slice(0, 200) }
                    : {}),
                  ...(Array.isArray(body.sourceChunkIds)
                    ? {
                        sourceChunkIds: body.sourceChunkIds
                          .map(Number)
                          .slice(0, 40),
                      }
                    : {}),
                  ...(typeof body.instructions === "string"
                    ? { instructions: body.instructions.slice(0, 5000) }
                    : {}),
                  ...(body.prior?.query && body.prior.answer
                    ? {
                        prior: {
                          query: String(body.prior.query).slice(0, 1000),
                          answer: String(body.prior.answer).slice(0, 2500),
                        },
                      }
                    : {}),
                },
                emit,
                request.signal,
              );
            } catch (error) {
              const typed = error as {
                name?: string;
                message?: string;
                status?: number;
                recoverable?: boolean;
              };
              const expected = typed.name === "KbAskError";
              emit("error", {
                message: expected
                  ? typed.message
                  : "Saved workspace Ask is temporarily unavailable.",
                status: expected ? (typed.status ?? 400) : 500,
                recoverable: expected ? (typed.recoverable ?? false) : true,
              });
            } finally {
              stopHeartbeat();
              closed = true;
              try {
                controller.close();
              } catch {
                // Client disconnected.
              }
            }
          },
        });
        return new Response(stream, { headers: sseHeaders() });
      },
    },
  },
});
