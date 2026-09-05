// ============================================================================
// Single explicit Supabase client for the I-9 audit feature.
// ALL audit queries, storage calls, and edge-function invocations go through
// this module, pointed at the real backend project. Never route audit traffic
// through the framework-managed default client in
// src/integrations/supabase/client.ts (that one belongs to the Lovable Cloud
// auth/news project).
// ============================================================================
import { createClient } from "@supabase/supabase-js";

export const AUDIT_SUPABASE_URL = "https://tbasvydiknulgtnsqvfp.supabase.co";
export const AUDIT_SUPABASE_ANON =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InRiYXN2eWRpa251bGd0bnNxdmZwIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODIzMzIxNjksImV4cCI6MjA5NzkwODE2OX0.ZxC8v10ya0T8YyoqxwA4FAVxSROOUUXlzonUc0rwgxw";

export const auditDb = createClient(AUDIT_SUPABASE_URL, AUDIT_SUPABASE_ANON, {
  auth: { persistSession: false, autoRefreshToken: false },
});

export const REVIEW_BUCKET = "review-files";
const FUNCTIONS_URL = `${AUDIT_SUPABASE_URL}/functions/v1`;

/**
 * Invoke an audit edge function with an explicit timeout. Used instead of
 * supabase-js functions.invoke so long OCR/extract calls get AbortController
 * control and raw JSON error bodies.
 */
export async function invokeAuditFunction<T>(
  name: string,
  body: unknown,
  opts?: { timeoutMs?: number; signal?: AbortSignal },
): Promise<T> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(new DOMException("timeout", "TimeoutError")), opts?.timeoutMs ?? 600_000);
  const onOuterAbort = () => ctl.abort();
  opts?.signal?.addEventListener("abort", onOuterAbort);
  try {
    const res = await fetch(`${FUNCTIONS_URL}/${name}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${AUDIT_SUPABASE_ANON}`,
      },
      body: JSON.stringify(body),
      signal: ctl.signal,
    });
    const json = (await res.json().catch(() => ({}))) as T & { error?: string };
    if (!res.ok && res.status !== 202) {
      throw new Error(json?.error ?? `${name} failed: HTTP ${res.status}`);
    }
    return json as T;
  } finally {
    clearTimeout(timer);
    opts?.signal?.removeEventListener("abort", onOuterAbort);
  }
}
