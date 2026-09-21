// Full-page read of a cited web source for the in-pane reader. Goes through the
// same SSRF-hardened fetcher the agent's fetch_page tool uses (public hosts only,
// redirect and size caps), gated by requireAuth.
import { createServerFn } from "@tanstack/react-start";

import { requireAuth } from "@/lib/auth/require-auth";

export type ReadSourceResult = {
  ok: boolean;
  title: string;
  text: string;
  finalUrl: string;
  truncated: boolean;
  /** Human-readable reason when ok is false (blocked host, timeout, no text). */
  note?: string;
};

/** Enough for a long opinion or agency page; the reader scrolls. */
const READER_MAX_CHARS = 80_000;

export const readSourceFn = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .inputValidator((d: { url: string }) => {
    const url = typeof d?.url === "string" ? d.url.trim() : "";
    if (!/^https?:\/\/\S+$/i.test(url) || url.length > 2_048)
      throw new Error("A public http(s) URL is required");
    return { url };
  })
  .handler(async ({ data }): Promise<ReadSourceResult> => {
    const { readPage: fetchPage } = await import("@/lib/agents/page-read.server");
    try {
      const page = await fetchPage(data.url, { maxChars: READER_MAX_CHARS, timeoutMs: 20_000 });
      const text = page.text.trim();
      if (!text) {
        return {
          ok: false,
          title: page.title,
          text: "",
          finalUrl: page.finalUrl,
          truncated: false,
          note: page.note || `No readable text at this address (status ${page.status}).`,
        };
      }
      return {
        ok: true,
        title: page.title,
        text,
        finalUrl: page.finalUrl,
        truncated: Boolean(page.truncated),
        ...(page.note ? { note: page.note } : {}),
      };
    } catch (err) {
      return {
        ok: false,
        title: "",
        text: "",
        finalUrl: data.url,
        truncated: false,
        note: err instanceof Error ? err.message : "Could not load the page.",
      };
    }
  });
