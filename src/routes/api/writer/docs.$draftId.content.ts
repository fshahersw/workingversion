// /api/writer/docs/:draftId/content
//   GET  ?version=N  -> DOCX bytes of that revision (default: current), with
//                       X-Writer-Version / X-Writer-Hash headers.
//   PUT  If-Match: <version loaded>, Idempotency-Key: <uuid>, body: DOCX
//                    -> saves a new revision; 409 when the server moved on.
import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/writer/docs/$draftId/content")({
  server: {
    handlers: {
      GET: async ({ request, params }) => {
        const { writerUser, writerErrorResponse, docxResponse } =
          await import("@/lib/writer/api.server");
        const user = await writerUser(request);
        if (user instanceof Response) return user;
        try {
          const { readWriterRevision } = await import("@/lib/writer/writer.server");
          const url = new URL(request.url);
          const raw = url.searchParams.get("version");
          const version = raw === null ? undefined : Number(raw);
          if (version !== undefined && (!Number.isInteger(version) || version < 1)) {
            return Response.json({ error: "Invalid revision." }, { status: 400 });
          }
          if (url.searchParams.get('download') === '1' || url.searchParams.get('direct') === '1') {
            const { grantOfficeRevision } = await import('@/lib/office/office.server');
            const grant = await grantOfficeRevision(user.sub, params.draftId, version);
            if (grant.kind !== 'docx') return Response.json({ error: 'Not a Word document.' }, { status: 422 });
            return url.searchParams.get('direct') === '1'
              ? Response.json(grant, { headers: { 'Cache-Control': 'no-store' } })
              : new Response(null, { status: 302, headers: { Location: grant.url, 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' } });
          }
          const rev = await readWriterRevision(user.sub, params.draftId, version);
          return docxResponse(rev.bytes, rev.name, {
            "X-Writer-Version": String(rev.version),
            "X-Writer-Hash": rev.hash,
          });
        } catch (err) {
          return writerErrorResponse(err);
        }
      },
      POST: async ({ request, params }) => {
        const { writerUser, writerErrorResponse } = await import('@/lib/writer/api.server');
        const user = await writerUser(request);
        if (user instanceof Response) return user;
        try {
          const { getWriterDoc } = await import('@/lib/writer/writer.server');
          await getWriterDoc(user.sub, params.draftId);
          const { prepareRevisionUpload, readRevisionUpload } = await import('@/lib/office/revision-upload.server');
          return Response.json(await prepareRevisionUpload(user.sub, await readRevisionUpload(request, params.draftId)), { headers: { 'Cache-Control': 'no-store' } });
        } catch (error) { return writerErrorResponse(error); }
      },
      PUT: async ({ request, params }) => {
        const { writerUser, writerErrorResponse, readDocxBody } =
          await import("@/lib/writer/api.server");
        const user = await writerUser(request);
        if (user instanceof Response) return user;
        try {
          if (request.headers.get('content-type')?.startsWith('application/json')) {
            const { getWriterDoc } = await import('@/lib/writer/writer.server');
            await getWriterDoc(user.sub, params.draftId);
            const { commitRevisionUpload, readRevisionUpload } = await import('@/lib/office/revision-upload.server');
            return Response.json(await commitRevisionUpload(user.sub, await readRevisionUpload(request, params.draftId)));
          }
          const { saveWriterRevision } = await import("@/lib/writer/writer.server");
          const expectedVersion = Number(request.headers.get("if-match") ?? "");
          const operationId = request.headers.get("idempotency-key") ?? "";
          if (!Number.isInteger(expectedVersion) || expectedVersion < 1) {
            return Response.json(
              { error: "If-Match with the loaded revision is required." },
              { status: 428 },
            );
          }
          const bytes = await readDocxBody(request);
          const saved = await saveWriterRevision(user.sub, {
            draftId: params.draftId,
            expectedVersion,
            bytes,
            operationId,
          });
          return Response.json(saved);
        } catch (err) {
          return writerErrorResponse(err);
        }
      },
    },
  },
});
