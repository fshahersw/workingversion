// Document summarizer endpoint (SSE). Text arrives already extracted client-side.
import { createFileRoute } from "@tanstack/react-router";

import { runSummarize, type PageText } from "@/lib/agents/summarizer.server";
import { WRITER_MODEL } from "@/lib/agents/anthropic.server";
import { fireworksEnabled, FIREWORKS_DIGEST_MODEL } from "@/lib/agents/fireworks.server";

function sseHeaders() {
  return {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-store, no-transform",
    Connection: "keep-alive",
  };
}

type Body = {
  title?: string;
  pages?: PageText[];
  instructions?: string;
  matter_label?: string;
  mode?: "fast" | "standard" | "thorough";
};

export const Route = createFileRoute("/api/summarize")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        let body: Body = {};
        try {
          body = (await request.json()) as Body;
        } catch {
          /* empty body */
        }
        const title = (body.title ?? "").trim() || "Untitled document";
        const pages = Array.isArray(body.pages) ? body.pages : [];
        if (!pages.length) return new Response("pages are required", { status: 400 });
        if (pages.length > 1200) return new Response("too many pages (max 1200)", { status: 400 });

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
              emit("run", {
                title,
                pages: pages.length,
                model: WRITER_MODEL,
                mode: body.mode,
                reader: fireworksEnabled() ? FIREWORKS_DIGEST_MODEL : WRITER_MODEL,
              });
              await runSummarize(
                {
                  title,
                  pages,
                  signal: request.signal,
                  ...(body.instructions ? { instructions: body.instructions } : {}),
                  ...(body.matter_label ? { matterLabel: body.matter_label } : {}),
                  ...(body.mode ? { mode: body.mode } : {}),
                },
                emit,
              );
            } catch (err) {
              emit("error", {
                message: err instanceof Error ? err.message : "Summarization failed.",
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
