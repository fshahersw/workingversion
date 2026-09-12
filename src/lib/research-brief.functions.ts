import { createServerFn } from "@tanstack/react-start";

import { requireAuth } from "@/lib/auth/require-auth";
import type { SwUser } from "@/lib/auth/cognito.server";

function principalOf(context: unknown): string {
  return (context as { user: SwUser }).user.sub;
}

export const loadResearchBriefFn = createServerFn({ method: "GET" })
  .middleware([requireAuth])
  .handler(async ({ context }) => {
    const { loadResearchBrief } = await import("@/lib/research-brief.server");
    return loadResearchBrief(principalOf(context));
  });
