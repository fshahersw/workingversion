// Server functions for the litigation intelligence terminal.
import { createServerFn } from "@tanstack/react-start";

import { requireAuth } from "@/lib/auth/require-auth";

import type { CorpusSignal, IntelFeedPage, IntelStatus } from "./intel-types";

export const getIntelFeed = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .inputValidator((data: { section: string; search?: string; limit?: number }) => data)
  .handler(async ({ data }): Promise<IntelFeedPage> => {
    const { loadIntelFeed } = await import("./intel.server");
    return loadIntelFeed(data);
  });

export const getIntelStatus = createServerFn({ method: "GET" })
  .middleware([requireAuth])
  .handler(async (): Promise<IntelStatus> => {
    const { loadIntelStatus } = await import("./intel.server");
    return loadIntelStatus();
  });

export const getCorpusSignals = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .inputValidator((data: { section: string }) => data)
  .handler(async ({ data }): Promise<CorpusSignal[]> => {
    const { loadCorpusSignals } = await import("./intel.server");
    return loadCorpusSignals(data.section);
  });
