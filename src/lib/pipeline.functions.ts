// Admin-only pipeline server functions, gated by the verified Cognito role.
import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";

import { requireAdmin } from "@/lib/auth/require-auth";

/** RPC payloads cross the wire as plain JSON. */
export type Json = string | number | boolean | null | Json[] | { [key: string]: Json };
const asJson = <T>(value: T): Json => JSON.parse(JSON.stringify(value)) as Json;

export const getPipelineOverview = createServerFn({ method: "GET" })
  .middleware([requireAdmin])
  .handler(async ({ context }) => {
    const email = context.user.email;
    const { listBatches, listRecentRejects, matterHealth, summarize } = await import("@/lib/pipeline.server");
    const [batches, rejects, health] = await Promise.all([
      listBatches(25).catch(() => []),
      listRecentRejects(50).catch(() => []),
      matterHealth().catch(() => []),
    ]);
    return {
      email,
      generated_at: new Date().toISOString(),
      summary: summarize(batches),
      batches: asJson(batches),
      rejects: asJson(rejects),
      health: asJson(health),
    };
  });

export const runPipelineSelfTest = createServerFn({ method: "POST" })
  .middleware([requireAdmin])
  .handler(async () => {
    const { runSelfTest } = await import("@/lib/ingest/selftest.server");
    const req = getRequest();
    const origin = new URL(req.url).origin;
    return asJson(await runSelfTest(origin));
  });

export const checkPipelineAccess = createServerFn({ method: "GET" })
  .middleware([requireAdmin])
  .handler(async () => {
    return { allowed: true };
  });

export const runIntelRefresh = createServerFn({ method: "POST" })
  .middleware([requireAdmin])
  .handler(async () => {
    const { runIntelCollection } = await import("@/lib/intel-collect.server");
    return asJson(await runIntelCollection());
  });

export const getDocketWatchOverview = createServerFn({ method: "GET" })
  .middleware([requireAdmin])
  .handler(async () => {
    const { docketWatchOverview } = await import("@/lib/pipeline.server");
    return asJson(await docketWatchOverview());
  });
