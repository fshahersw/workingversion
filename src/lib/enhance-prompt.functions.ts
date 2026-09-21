// Client-callable server function for the "Enhance my prompt" tool.
import { createServerFn } from "@tanstack/react-start";

import { requireAuth } from "@/lib/auth/require-auth";

export type EnhanceInput = {
  /** The user's current prompt, as typed. */
  prompt: string;
  /** Optional instruction for how to improve it. */
  improve?: string;
  /** Optional default jurisdiction to fold in when the prompt is ambiguous. */
  jurisdiction?: string;
};

export type EnhanceResult = {
  /** False when the prompt was already clear (skipped); expandedPrompt echoes the original. */
  applied: boolean;
  expandedPrompt: string;
  /** Plain-language bullets explaining each change (for the user). */
  reasoning: string[];
  /** When not applied, why. */
  skipReason: string | null;
};

export const enhancePromptFn = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .inputValidator((data: EnhanceInput) => data)
  .handler(async ({ data }): Promise<EnhanceResult> => {
    const { enhancePrompt } = await import("./enhance-prompt.server");
    return enhancePrompt(data);
  });
