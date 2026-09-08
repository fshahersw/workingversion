import { createFileRoute } from "@tanstack/react-router";

import {
  REVIEW_ESCALATE_LOW_CONFIDENCE,
  REVIEW_PIPELINE_ENABLED,
  REVIEW_SKIP_VERIFY,
  REVIEW_TABLES_ENABLED,
  type ColumnKind,
} from "@/lib/review/types";

const KINDS: ColumnKind[] = [
  "text",
  "long_text",
  "yes_no",
  "date",
  "number",
  "select",
  "multi_select",
  "list",
];

export const Route = createFileRoute("/api/review/cell")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        if (!REVIEW_TABLES_ENABLED) {
          return Response.json({ error: "Tabular Review is disabled" }, { status: 404 });
        }
        // apiAuthMiddleware already gates /api/*; verifying here as well keeps
        // this route safe if the middleware list is ever edited.
        const { getUserFromRequest } = await import("@/lib/auth/cognito.server");
        const user = await getUserFromRequest(request);
        if (!user) return Response.json({ error: "unauthorized" }, { status: 401 });
        let body: {
          columnName?: string;
          question?: string;
          kind?: string;
          options?: unknown;
          instructions?: string | null;
          fileName?: string;
          pages?: { page?: number; text?: string; ocr?: boolean }[];
        } = {};
        try {
          body = (await request.json()) as typeof body;
        } catch {
          /* empty */
        }

        const question = (body.question ?? "").trim();
        if (!question) return Response.json({ error: "question required" }, { status: 400 });

        const kind = (KINDS as string[]).includes(body.kind ?? "")
          ? (body.kind as ColumnKind)
          : "text";
        const pages = (body.pages ?? [])
          .filter((p) => Number.isFinite(Number(p.page)) && typeof p.text === "string")
          .slice(0, 24)
          .map((p) => ({
            page: Number(p.page),
            text: String(p.text).slice(0, 24000),
            ocr: !!p.ocr,
          }));

        const req = {
          columnName: (body.columnName ?? "Field").slice(0, 120),
          question: question.slice(0, 2000),
          kind,
          options: Array.isArray(body.options)
            ? body.options.map((o) => String(o)).slice(0, 40)
            : [],
          instructions: body.instructions ?? null,
          fileName: (body.fileName ?? "document").slice(0, 300),
          pages,
        };

        try {
          if (REVIEW_PIPELINE_ENABLED) {
            const { pipelineModel, runCellPipeline } = await import(
              "@/lib/review/cell-pipeline.server"
            );
            const answer = await runCellPipeline(req, {
              skipVerify: REVIEW_SKIP_VERIFY,
              skipEscalate: !REVIEW_ESCALATE_LOW_CONFIDENCE,
            });
            return Response.json({
              ...answer,
              model: pipelineModel(),
              pagesSearched: pages.map((p) => p.page),
            });
          }

          const { answerCell, cellModel } = await import("@/lib/review/cell.server");
          const answer = await answerCell(req);
          return Response.json({ ...answer, model: cellModel() });
        } catch (err) {
          return Response.json(
            { error: err instanceof Error ? err.message : "Cell extraction failed" },
            { status: 500 },
          );
        }
      },
    },
  },
});
