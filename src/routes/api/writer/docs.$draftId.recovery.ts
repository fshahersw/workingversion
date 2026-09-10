// /api/writer/docs/:draftId/recovery — crash-recovery copy of unsaved work.
//   POST If-Match: <base version>, body: DOCX -> stores the snapshot
//   GET  -> the snapshot bytes (404 when none is newer than the saved revision)
import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/writer/docs/$draftId/recovery")({
  server: {
    handlers: {
      GET: async ({ request, params }) => {
        const { writerUser, writerErrorResponse, docxResponse } =
          await import("@/lib/writer/api.server");
        const user = await writerUser(request);
        if (user instanceof Response) return user;
        try {
          const { readWriterRecovery } = await import("@/lib/writer/writer.server");
          const rec = await readWriterRecovery(user.sub, params.draftId);
          return docxResponse(rec.bytes, rec.name);
        } catch (err) {
          return writerErrorResponse(err);
        }
      },
      POST: async ({ request, params }) => {
        const { writerUser, writerErrorResponse, readDocxBody } =
          await import("@/lib/writer/api.server");
        const user = await writerUser(request);
        if (user instanceof Response) return user;
        try {
          const { putWriterRecovery } = await import("@/lib/writer/writer.server");
          const baseVersion = Number(request.headers.get("if-match") ?? "");
          if (!Number.isInteger(baseVersion) || baseVersion < 1) {
            return Response.json(
              { error: "If-Match with the loaded revision is required." },
              { status: 428 },
            );
          }
          const bytes = await readDocxBody(request);
          return Response.json(
            await putWriterRecovery(user.sub, { draftId: params.draftId, baseVersion, bytes }),
          );
        } catch (err) {
          return writerErrorResponse(err);
        }
      },
    },
  },
});
