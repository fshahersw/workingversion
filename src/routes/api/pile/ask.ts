import { createFileRoute } from "@tanstack/react-router";

function sseHeaders() {
  return {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-store, no-transform",
    Connection: "keep-alive",
  };
}

export const Route = createFileRoute("/api/pile/ask")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        let body: {
          query?: string;
          pages?: { fileName?: string; page?: number; text?: string; ocr?: boolean; cite?: string }[];
          hits?: unknown[];
          files?: { name?: string; pageCount?: number }[];
          fileGroups?: {
            fileId?: string;
            fileName?: string;
            pageCount?: number;
            matched?: boolean;
            topScore?: number;
            pages?: { fileName?: string; page?: number; text?: string; ocr?: boolean }[];
          }[];
          structure?: unknown;
          instructions?: string | null;
          mode?: "ask" | "analyze";
          pass?:
            | "case"
            | "record"
            | "connections"
            | "cross"
            | "cover"
            | "synth"
            | "profile"
            | "admissions"
            | "chronology"
            | "exhibits";
          caption?: string | null;
          citeReady?: boolean;
          witness?: string | null;
        } = {};
        try {
          body = (await request.json()) as typeof body;
        } catch {
          /* empty */
        }
        const query = (body.query ?? "").trim();
        const pages = (body.pages ?? [])
          .filter((p) => p.fileName && p.page && typeof p.text === "string")
          .map((p) => ({
            fileName: String(p.fileName),
            page: Number(p.page),
            text: String(p.text),
            ocr: !!p.ocr,
            cite: p.cite ? String(p.cite) : undefined,
          }));
        const fileGroups = (body.fileGroups ?? [])
          .filter((g) => g.fileId && g.fileName)
          .map((g) => ({
            fileId: String(g.fileId),
            fileName: String(g.fileName),
            pageCount: Number(g.pageCount) || 0,
            matched: !!g.matched,
            topScore: Number(g.topScore) || 0,
            pages: (g.pages ?? [])
              .filter((p) => p.page && typeof p.text === "string")
              .map((p) => ({
                fileName: String(p.fileName ?? g.fileName),
                page: Number(p.page),
                text: String(p.text),
                ocr: !!p.ocr,
              })),
          }))
          .filter((g) => g.pages.length);
        if (!query) return new Response("query is required", { status: 400 });
        if (!pages.length && !fileGroups.length) {
          return new Response("pages are required", { status: 400 });
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
            try {
              const hits = Array.isArray(body.hits) ? (body.hits as never) : undefined;
              if (body.mode === "analyze") {
                const { writeDepositionAnalysis } = await import("@/lib/pile/ask-deposition.server");
                await writeDepositionAnalysis(
                  {
                    query,
                    pages,
                    hits,
                    files: (body.files ?? [])
                      .filter((f) => f.name)
                      .map((f) => ({ name: String(f.name), pageCount: Number(f.pageCount) || 0 })),
                    instructions: body.instructions ?? null,
                    pass:
                      body.pass === "case" ||
                      body.pass === "record" ||
                      body.pass === "connections" ||
                      body.pass === "cross" ||
                      body.pass === "cover" ||
                      body.pass === "synth" ||
                      body.pass === "profile" ||
                      body.pass === "admissions" ||
                      body.pass === "chronology" ||
                      body.pass === "exhibits"
                        ? body.pass
                        : undefined,
                    caption: body.caption ?? null,
                    citeReady: !!body.citeReady,
                    witness: body.witness ?? null,
                  },
                  emit,
                  request.signal,
                );
                return;
              }
              // More than one document in the pile -> read each file on its own,
              // then synthesize across the per-file digests.
              if (fileGroups.length > 1) {
                const { writeMultiFileAnswer } = await import("@/lib/pile/ask.server");
                await writeMultiFileAnswer(
                  {
                    query,
                    files: fileGroups,
                    hits,
                    structure: (body.structure as never) ?? null,
                    instructions: body.instructions ?? null,
                  },
                  emit,
                  request.signal,
                );
                return;
              }
              const { writePileAnswer } = await import("@/lib/pile/ask.server");
              await writePileAnswer(
                {
                  query,
                  pages: pages.length ? pages : (fileGroups[0]?.pages ?? []),
                  hits,
                  files: (body.files ?? [])
                    .filter((f) => f.name)
                    .map((f) => ({ name: String(f.name), pageCount: Number(f.pageCount) || 0 })),
                  structure: (body.structure as never) ?? null,
                  instructions: body.instructions ?? null,
                },
                emit,
                request.signal,
              );
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
