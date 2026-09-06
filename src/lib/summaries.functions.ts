// Client-callable server functions for the document summarizer.
import { createServerFn } from "@tanstack/react-start";

import { requireAdmin, requireAuth } from "@/lib/auth/require-auth";

import type { SaveSummaryInput, SummaryRecord } from "./summaries.server";

export const listDocSummaries = createServerFn({ method: "GET" })
  .middleware([requireAuth])
  .handler(async (): Promise<Partial<SummaryRecord>[]> => {
    const { listSummaries } = await import("./summaries.server");
    return listSummaries();
  });

export const getDocSummary = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .inputValidator((data: { id: string }) => data)
  .handler(async ({ data }): Promise<SummaryRecord | null> => {
    const { getSummary } = await import("./summaries.server");
    return getSummary(data.id);
  });

export const deleteDocSummary = createServerFn({ method: "POST" })
  .middleware([requireAdmin])
  .inputValidator((data: { id: string }) => data)
  .handler(async ({ data }): Promise<{ ok: true }> => {
    const { deleteSummary } = await import("./summaries.server");
    await deleteSummary(data.id);
    return { ok: true };
  });

export const saveDocSummary = createServerFn({ method: "POST" })
  .middleware([requireAdmin])
  .inputValidator((data: SaveSummaryInput) => data)
  .handler(async ({ data }): Promise<{ summary_id: string }> => {
    const { saveSummary } = await import("./summaries.server");
    return saveSummary(data);
  });

export const getSummaryUploadUrls = createServerFn({ method: "POST" })
  .middleware([requireAdmin])
  .inputValidator((data: { runId: string; files: { name: string }[] }) => data)
  .handler(async ({ data }): Promise<{ name: string; key: string; url: string }[]> => {
    const { summaryUploadUrls } = await import("./summaries.server");
    return summaryUploadUrls(data.runId, data.files);
  });

export const getSummarySourceUrl = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .inputValidator((data: { key: string }) => data)
  .handler(async ({ data }): Promise<{ url: string }> => {
    const { summaryFileUrl } = await import("./summaries.server");
    return { url: await summaryFileUrl(data.key) };
  });
