import { createServerFn } from "@tanstack/react-start";
import { requireAuth } from "@/lib/auth/require-auth";

export const officeVoiceStatusFn = createServerFn({ method: "GET" })
  .middleware([requireAuth])
  .handler(async () => {
    const { officeVoiceEnabled } = await import("./voice-grant.server");
    return { enabled: officeVoiceEnabled() };
  });

export const officeVoiceGrantFn = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .inputValidator((input: { app: string; document: string; mode: string }) => {
    if (!input || !["writer", "sheets", "slides"].includes(input.app))
      throw new Error("Invalid Office app");
    if (typeof input.document !== "string" || input.document.length > 500)
      throw new Error("Invalid document");
    if (!["write", "ask", "review"].includes(input.mode))
      throw new Error("Voice is available in Write, Ask, and Review modes.");
    return input;
  })
  .handler(async ({ data, context }) => {
    const { issueVoiceGrant } = await import("./voice-grant.server");
    return issueVoiceGrant(context.user.sub, data);
  });
