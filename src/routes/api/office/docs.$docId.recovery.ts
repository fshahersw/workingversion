// /api/office/docs/:docId/recovery — crash-recovery copy of unsaved work.
//   POST If-Match: <base version>, body: package -> stores the snapshot
//   GET  -> the snapshot bytes (404 when none is newer than the saved revision)
import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/office/docs/$docId/recovery")({
  server: {
    handlers: {
      GET: async ({ request, params }) => {
        const { officeUser, officeErrorResponse, packageResponse } =
          await import("@/lib/office/api.server");
        const user = await officeUser(request, { docId: params.docId });
        if (user instanceof Response) return user;
        try {
          const { readOfficeRecovery } = await import("@/lib/office/office.server");
          const rec = await readOfficeRecovery(user.sub, params.docId);
          return packageResponse(rec.bytes, rec.name, rec.kind);
        } catch (err) {
          return officeErrorResponse(err);
        }
      },
      POST: async ({ request, params }) => {
        const { officeUser, officeErrorResponse, readPackageBody } =
          await import("@/lib/office/api.server");
        const user = await officeUser(request, { docId: params.docId });
        if (user instanceof Response) return user;
        try {
          const { putOfficeRecovery } = await import("@/lib/office/office.server");
          const baseVersion = Number(request.headers.get("if-match") ?? "");
          if (!Number.isInteger(baseVersion) || baseVersion < 1) {
            return Response.json(
              { error: "If-Match with the loaded revision is required." },
              { status: 428 },
            );
          }
          const bytes = await readPackageBody(request);
          return Response.json(
            await putOfficeRecovery(user.sub, { docId: params.docId, baseVersion, bytes }),
          );
        } catch (err) {
          return officeErrorResponse(err);
        }
      },
    },
  },
});
