// Server functions for the Legal Archive pages (Sources & Coverage first).
import { createServerFn } from "@tanstack/react-start";

import { requireAuth } from "@/lib/auth/require-auth";

import type { ArchiveHealth } from "./client.server";
import type { JsonValue } from "./policy";

export type CoverageSnapshot = {
  labels: JsonValue | null;
  matrix: JsonValue | null;
  error: string | null;
};

export const getArchiveHealth = createServerFn({ method: "GET" })
  .middleware([requireAuth])
  .handler(async (): Promise<ArchiveHealth> => {
    const { archiveHealth } = await import("./client.server");
    return archiveHealth();
  });

export const getArchiveCoverage = createServerFn({ method: "GET" })
  .middleware([requireAuth])
  .handler(async (): Promise<CoverageSnapshot> => {
    const { archiveEnabled, archiveGet } = await import("./client.server");
    if (!archiveEnabled()) return { labels: null, matrix: null, error: "legal archive not configured" };
    const [labels, matrix] = await Promise.allSettled([
      archiveGet<JsonValue>("/api/coverage/labels", undefined, { timeoutMs: 15_000 }),
      archiveGet<JsonValue>("/api/coverage/matrix", undefined, { timeoutMs: 20_000 }),
    ]);
    const firstError = [labels, matrix].find((r) => r.status === "rejected") as PromiseRejectedResult | undefined;
    return {
      labels: labels.status === "fulfilled" ? labels.value.data : null,
      matrix: matrix.status === "fulfilled" ? matrix.value.data : null,
      error: firstError ? (firstError.reason instanceof Error ? firstError.reason.message : String(firstError.reason)) : null,
    };
  });
