// Owner-only pipeline server functions. Every handler re-checks the verified
// Supabase email against the server allowlist — the route guard is UX only.
import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";

import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

/** RPC payloads cross the wire as plain JSON. */
export type Json = string | number | boolean | null | Json[] | { [key: string]: Json };
const asJson = <T>(value: T): Json => JSON.parse(JSON.stringify(value)) as Json;

async function requireAdmin(context: { supabase: { auth: { getUser: () => Promise<{ data: { user: { email?: string | null } | null } }> } } }) {
  const { isAdminEmail } = await import("@/lib/pipeline.server");
  const { data } = await context.supabase.auth.getUser();
  const email = data.user?.email ?? null;
  if (!isAdminEmail(email)) throw new Error("Forbidden");
  return email as string;
}

export const getPipelineOverview = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const email = await requireAdmin(context as never);
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
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await requireAdmin(context as never);
    const { runSelfTest } = await import("@/lib/ingest/selftest.server");
    const req = getRequest();
    const origin = new URL(req.url).origin;
    return asJson(await runSelfTest(origin));
  });

export const checkPipelineAccess = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    const { isAdminEmail } = await import("@/lib/pipeline.server");
    const { data } = await (context as { supabase: { auth: { getUser: () => Promise<{ data: { user: { email?: string | null } | null } }> } } }).supabase.auth.getUser();
    return { allowed: isAdminEmail(data.user?.email ?? null) };
  });

export const runIntelRefresh = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await requireAdmin(context as never);
    const { runIntelCollection } = await import("@/lib/intel-collect.server");
    return asJson(await runIntelCollection());
  });

export const getDocketWatchOverview = createServerFn({ method: "GET" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }) => {
    await requireAdmin(context as never);
    const { docketWatchOverview } = await import("@/lib/pipeline.server");
    return asJson(await docketWatchOverview());
  });
