// /api/office/docs/:docId/content
//   GET  ?version=N  -> package bytes of that revision (default: current) with
//                       X-Office-Version / X-Office-Hash / X-Office-Kind headers.
//   PUT  If-Match: <version loaded>, Idempotency-Key: <uuid>, body: package
//                    -> saves a new revision; 409 when the server moved on.
// Accepts the platform session cookie or a Bearer engine token scoped to docId.
import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/office/docs/$docId/content")({
  server: {
    handlers: {
      GET: async ({ request, params }) => {
        const { officeUser, officeErrorResponse, packageResponse } =
          await import("@/lib/office/api.server");
        const user = await officeUser(request, { docId: params.docId });
        if (user instanceof Response) return user;
        try {
          const { readOfficeRevision } = await import("@/lib/office/office.server");
          const url = new URL(request.url);
          const raw = url.searchParams.get("version");
          const version = raw === null ? undefined : Number(raw);
          if (version !== undefined && (!Number.isInteger(version) || version < 1)) {
            return Response.json({ error: "Invalid revision." }, { status: 400 });
          }
          const rev = await readOfficeRevision(user.sub, params.docId, version);
          return packageResponse(rev.bytes, rev.name, rev.kind, {
            "X-Office-Version": String(rev.version),
            "X-Office-Hash": rev.hash,
            "X-Office-Kind": rev.kind,
          });
        } catch (err) {
          return officeErrorResponse(err);
        }
      },
      PUT: async ({ request, params }) => {
        const { officeUser, officeErrorResponse, readPackageBody } =
          await import("@/lib/office/api.server");
        const user = await officeUser(request, { docId: params.docId });
        if (user instanceof Response) return user;
        try {
          const { saveOfficeRevision } = await import("@/lib/office/office.server");
          const expectedVersion = Number(request.headers.get("if-match") ?? "");
          const operationId = request.headers.get("idempotency-key") ?? "";
          if (!Number.isInteger(expectedVersion) || expectedVersion < 1) {
            return Response.json(
              { error: "If-Match with the loaded revision is required." },
              { status: 428 },
            );
          }
          const bytes = await readPackageBody(request);
          const saved = await saveOfficeRevision(user.sub, {
            docId: params.docId,
            expectedVersion,
            bytes,
            operationId,
          });
          return Response.json(saved);
        } catch (err) {
          return officeErrorResponse(err);
        }
      },
    },
  },
});
