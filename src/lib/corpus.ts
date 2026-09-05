// ============================================================================
// Corpus backend client config (external Supabase project holding the corpus).
//
// The app reads the NEW `corpus` schema through public-schema bridge views
// (public.corpus_*), so the default PostgREST profile works — no
// Accept-Profile header needed. The legacy `registry` schema remains for the
// agent tooling until the RAG cutover.
//
// The corpus project is NOT the Lovable-managed backend, so these must stay
// pinned here — reading SUPABASE_URL would point at the managed project and
// mismatch CORPUS_SERVICE_KEY (401 "Invalid API key").
// ============================================================================
import { createClient } from "@supabase/supabase-js";

// Corpus connection creds. Publishable key + URL come from env (VITE_ for the
// client bundle, process.env for SSR); the pinned values below are the dev
// fallback so local dev works without extra setup. The SENSITIVE service key is
// server-only and read from process.env.CORPUS_SERVICE_KEY (never in source).
// Set in .env: VITE_CORPUS_URL, VITE_CORPUS_KEY, CORPUS_SERVICE_KEY.
export const CORPUS_URL =
  import.meta.env.VITE_CORPUS_URL ||
  (typeof process !== "undefined" ? process.env.CORPUS_URL : undefined) ||
  "https://odwhzepghulspdzmzhhz.supabase.co";
export const CORPUS_KEY =
  import.meta.env.VITE_CORPUS_KEY ||
  (typeof process !== "undefined" ? process.env.CORPUS_KEY : undefined) ||
  "sb_publishable_3dqNzUbWYPa27v_5oONvCw_iBx4yPiw";

/** Legacy registry-era bucket (agent tooling until RAG cutover). */
export const CORPUS_BUCKET = "FORAWS";
/** New canonical corpus bucket: <slug>/pdf|text|incoming/… */
export const MATTERS_BUCKET = "matters";

export const corpus = createClient(CORPUS_URL, CORPUS_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

/** Public URL for an object in a corpus storage bucket. */
export function corpusFileUrl(path: string, bucket: string = CORPUS_BUCKET): string {
  return corpus.storage.from(bucket).getPublicUrl(path).data.publicUrl;
}

/** Signed URL (private bucket); falls back to the public URL on failure. */
export async function corpusSignedUrl(
  path: string,
  expiresIn = 3600,
  bucket: string = CORPUS_BUCKET,
): Promise<string> {
  const { data, error } = await corpus.storage.from(bucket).createSignedUrl(path, expiresIn);
  if (error || !data?.signedUrl) return corpusFileUrl(path, bucket);
  return data.signedUrl;
}
