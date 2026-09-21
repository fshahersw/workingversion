// PUT /api/public/office/engine/docs/:docId/content — the Office engine
// service saving a new revision on the user's behalf. Authenticated ONLY by a
// Bearer engine token this platform minted (scoped to the user and this docId);
// there is no session cookie on this path, which is why it lives under
// /api/public. Same If-Match / Idempotency-Key contract as the browser route.
import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/public/office/engine/docs/$docId/content")({
  server: {
    handlers: {
      POST: async ({ request, params }) => {
        const auth = request.headers.get('authorization') ?? '';
        if (!auth.startsWith('Bearer ')) return Response.json({error:'An engine token is required.'},{status:401});
        const { verifyEngineToken } = await import('@/lib/office/engine-token-verify.server');
        const claims = await verifyEngineToken(auth.slice(7),request.url).catch(()=>null);
        if (!claims) return Response.json({error:'The engine token is invalid or expired.'},{status:401});
        if (claims.doc !== params.docId) return Response.json({error:'The engine token is not scoped to this document.'},{status:403});
        const { officeErrorResponse } = await import('@/lib/office/api.server');
        try {
          const {prepareRevisionUpload,readRevisionUpload} = await import('@/lib/office/revision-upload.server');
          return Response.json(await prepareRevisionUpload(claims.sub,await readRevisionUpload(request,params.docId)),{headers:{'Cache-Control':'no-store'}});
        } catch(error) { return officeErrorResponse(error); }
      },
      PUT: async ({ request, params }) => {
        const { officeErrorResponse, readPackageBody } = await import("@/lib/office/api.server");
        const auth = request.headers.get("authorization") ?? "";
        if (!auth.startsWith("Bearer ")) {
          return Response.json({ error: "An engine token is required." }, { status: 401 });
        }
        const { verifyEngineToken } = await import("@/lib/office/engine-token-verify.server");
        const claims = await verifyEngineToken(auth.slice(7), request.url).catch(() => null);
        if (!claims)
          return Response.json(
            { error: "The engine token is invalid or expired." },
            { status: 401 },
          );
        if (claims.doc !== params.docId) {
          return Response.json(
            { error: "The engine token is not scoped to this document." },
            { status: 403 },
          );
        }
        try {
          if (request.headers.get('content-type')?.startsWith('application/json')) {
            const {commitRevisionUpload,readRevisionUpload} = await import('@/lib/office/revision-upload.server');
            return Response.json(await commitRevisionUpload(claims.sub,await readRevisionUpload(request,params.docId)));
          }
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
          const saved = await saveOfficeRevision(claims.sub, {
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
