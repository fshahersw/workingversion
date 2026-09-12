import { createFileRoute } from "@tanstack/react-router";

import {
  REVIEW_ESCALATE_LOW_CONFIDENCE,
  REVIEW_PIPELINE_ENABLED,
  REVIEW_SKIP_VERIFY,
  REVIEW_TABLES_ENABLED,
  REVIEW_VISION_MAX_IMAGE_CHARS,
  REVIEW_VISION_MAX_PAGES,
  type CellPageImage,
  type ColumnKind,
} from "@/lib/review/types";

const IMAGE_TYPES = new Set<CellPageImage["mediaType"]>(["image/jpeg", "image/png", "image/webp"]);
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

function cleanImages(raw: unknown): CellPageImage[] {
  if (!Array.isArray(raw)) return [];
  const out: CellPageImage[] = [];
  for (const item of raw.slice(0, REVIEW_VISION_MAX_PAGES)) {
    if (!item || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    const page = Number(o.page);
    const mediaType = String(o.mediaType ?? "") as CellPageImage["mediaType"];
    const data = typeof o.data === "string" ? o.data : "";
    if (!Number.isFinite(page) || page <= 0 || !IMAGE_TYPES.has(mediaType)) continue;
    if (!data || data.length > REVIEW_VISION_MAX_IMAGE_CHARS || !BASE64.test(data)) continue;
    out.push({ page, mediaType, data });
  }
  return out;
}

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
          documentContext?: string;
          columnName?: string;
          question?: string;
          kind?: string;
          options?: unknown;
          instructions?: string | null;
          fileName?: string;
          pages?: { page?: number; text?: string; ocr?: boolean }[];
          images?: unknown;
        } = {};
        try {
          body = (await request.json()) as typeof body;
        } catch {
          /* empty */
        }

        if (
          typeof body.question !== "string" ||
          !Array.isArray(body.pages) ||
          body.pages.some(
            (p) =>
              !p || !Number.isInteger(p.page) || Number(p.page) < 1 || typeof p.text !== "string",
          ) ||
          (body.instructions != null && typeof body.instructions !== "string")
        )
          return Response.json({ error: "Invalid cell question or source pages" }, { status: 400 });
        if (
          body.documentContext != null &&
          (typeof body.documentContext !== "string" || body.documentContext.length > 6000)
        )
          return Response.json({ error: "Invalid document orientation" }, { status: 400 });
        const question = body.question.trim();
        if (!question) return Response.json({ error: "question required" }, { status: 400 });
        if (
          question.length > 2000 ||
          (body.instructions?.length ?? 0) > 16000 ||
          body.pages.length > 24 ||
          body.pages.some((p) => p.text!.length > 32_000) ||
          body.pages.reduce((sum, p) => sum + p.text!.length, 0) > 120_000
        )
          return Response.json(
            {
              error:
                "Cell context exceeds its supported window. Use a full text scan to cover the document in bounded sections.",
            },
            { status: 413 },
          );

        const kind = (KINDS as string[]).includes(body.kind ?? "")
          ? (body.kind as ColumnKind)
          : "text";
        const pages = (body.pages ?? [])
          .filter((p) => Number.isFinite(Number(p.page)) && typeof p.text === "string")
          .map((p) => ({
            page: Number(p.page),
            text: String(p.text),
            ocr: !!p.ocr,
          }));

        const req = {
          documentContext: body.documentContext,
          columnName: (body.columnName ?? "Field").slice(0, 120),
          question,
          kind,
          options: Array.isArray(body.options)
            ? body.options.map((o) => String(o)).slice(0, 40)
            : [],
          instructions: body.instructions ?? null,
          fileName: (body.fileName ?? "document").slice(0, 300),
          pages,
          images: cleanImages(body.images),
        };

        try {
          if (REVIEW_PIPELINE_ENABLED) {
            const { pipelineModel, runCellPipeline } =
              await import("@/lib/review/cell-pipeline.server");
            const answer = await runCellPipeline(req, {
              skipVerify: REVIEW_SKIP_VERIFY,
              skipEscalate: !REVIEW_ESCALATE_LOW_CONFIDENCE,
              signal: request.signal,
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
