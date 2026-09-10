// POST /api/writer/docs — create a Writer document from DOCX bytes (a blank
// built in the browser, or an uploaded file). Body: the DOCX; header
// X-Writer-Filename: URL-encoded display name. Returns the document summary.
import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/writer/docs")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const { writerUser, writerErrorResponse, readDocxBody } =
          await import("@/lib/writer/api.server");
        const user = await writerUser(request);
        if (user instanceof Response) return user;
        try {
          const { createWriterDoc } = await import("@/lib/writer/writer.server");
          const bytes = await readDocxBody(request);
          let name = "";
          try {
            name = decodeURIComponent(request.headers.get("x-writer-filename") ?? "");
          } catch {
            name = "";
          }
          const folderId = request.headers.get("x-writer-folder") ?? undefined;
          const summary = await createWriterDoc(user.sub, {
            bytes,
            ...(name ? { name } : {}),
            ...(folderId ? { folderId } : {}),
          });
          return Response.json(summary, { status: 201 });
        } catch (err) {
          return writerErrorResponse(err);
        }
      },
    },
  },
});
