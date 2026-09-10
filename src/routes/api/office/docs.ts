// POST /api/office/docs — create an Office document from package bytes.
// Headers: X-Office-Kind (docx|xlsx), X-Office-Filename (URL-encoded),
// optional X-Office-Folder. Body: the package. Returns the document summary.
import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/office/docs")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const { officeUser, officeErrorResponse, readPackageBody } =
          await import("@/lib/office/api.server");
        const user = await officeUser(request);
        if (user instanceof Response) return user;
        try {
          const { createOfficeDoc } = await import("@/lib/office/office.server");
          const { isOfficeKind } = await import("@/lib/office/types");
          const kind = request.headers.get("x-office-kind");
          if (!isOfficeKind(kind))
            return Response.json({ error: "X-Office-Kind must be docx or xlsx." }, { status: 400 });
          const bytes = await readPackageBody(request);
          let name = "";
          try {
            name = decodeURIComponent(request.headers.get("x-office-filename") ?? "");
          } catch {
            name = "";
          }
          const folderId = request.headers.get("x-office-folder") ?? undefined;
          const summary = await createOfficeDoc(user.sub, {
            kind,
            bytes,
            ...(name ? { name } : {}),
            ...(folderId ? { folderId } : {}),
          });
          return Response.json(summary, { status: 201 });
        } catch (err) {
          return officeErrorResponse(err);
        }
      },
    },
  },
});
