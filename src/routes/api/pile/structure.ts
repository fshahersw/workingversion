import { createFileRoute } from "@tanstack/react-router";

export const Route = createFileRoute("/api/pile/structure")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        let body: {
          files?: { name?: string; pageCount?: number }[];
          pages?: { fileName?: string; page?: number; text?: string }[];
          matterLabel?: string | null;
        } = {};
        try {
          body = (await request.json()) as typeof body;
        } catch {
          /* empty */
        }
        const files = (body.files ?? [])
          .filter((f) => f.name)
          .map((f) => ({ name: String(f.name), pageCount: Number(f.pageCount) || 0 }));
        const pages = (body.pages ?? [])
          .filter((p) => p.fileName && p.page)
          .map((p) => ({
            fileName: String(p.fileName),
            page: Number(p.page),
            text: String(p.text ?? ""),
          }));
        if (!files.length) {
          return Response.json({ error: "files required" }, { status: 400 });
        }
        try {
          const { structureFromPages } = await import("@/lib/pile/structure.server");
          const structure = await structureFromPages({
            files,
            pages,
            matterLabel: body.matterLabel,
          });
          return Response.json(structure);
        } catch (err) {
          return Response.json(
            { error: err instanceof Error ? err.message : "structure failed" },
            { status: 400 },
          );
        }
      },
    },
  },
});
