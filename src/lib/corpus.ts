// ============================================================================
// Corpus backend client config (external Supabase project holding the corpus).
//
// The app reads the NEW `corpus` schema through public-schema bridge views
// (public.corpus_*), so the default PostgREST profile works — no
// Accept-Profile header needed. The legacy `registry` schema remains for the
// agent tooling until the RAG cutover.
//
// The corpus project is NOT the Lovable-managed backend, so generic
// SUPABASE_URL must not be used: it points at the Lovable-managed project and
// mismatches CORPUS_SERVICE_KEY (401 "Invalid API key").
// ============================================================================
import { createClient } from "@supabase/supabase-js";
import {
  loadCorpusConfig,
  type EnvSource,
} from "./config.server";

// Corpus connection creds. Publishable key + URL come from env (VITE_ for the
// Vite bundle, process.env for SSR). Development defaults keep local setup
// convenient; production requires explicit values. The SENSITIVE service key
// is server-only and read from process.env.CORPUS_SERVICE_KEY (never in source).
// Set in .env: VITE_CORPUS_URL, VITE_CORPUS_KEY, CORPUS_SERVICE_KEY.
function corpusEnv(): EnvSource {
  const runtime = typeof process === "undefined" ? undefined : process.env;
  const vite = import.meta.env as ImportMetaEnv | undefined;
  if (typeof window === "undefined" && runtime) {
    return {
      NODE_ENV: runtime["NODE_ENV"],
      CORPUS_URL: runtime["CORPUS_URL"] ?? runtime["VITE_CORPUS_URL"],
      CORPUS_KEY: runtime["CORPUS_KEY"] ?? runtime["VITE_CORPUS_KEY"],
    };
  }
  return {
    NODE_ENV: vite?.PROD ? "production" : vite?.MODE,
    VITE_CORPUS_URL: vite?.VITE_CORPUS_URL,
    VITE_CORPUS_KEY: vite?.VITE_CORPUS_KEY,
  };
}

export function corpusConfig(): ReturnType<typeof loadCorpusConfig> {
  return loadCorpusConfig(corpusEnv());
}

export function corpusUrl(): string {
  return corpusConfig().url;
}

/** Legacy registry-era bucket (agent tooling until RAG cutover). */
export const CORPUS_BUCKET = "FORAWS";
/** New canonical corpus bucket: <slug>/pdf|text|incoming/… */
export const MATTERS_BUCKET = "matters";

let _corpus: ReturnType<typeof createClient> | undefined;
function corpusClient(): ReturnType<typeof createClient> {
  if (!_corpus) {
    const { url, key } = corpusConfig();
    _corpus = createClient(url, key, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  }
  return _corpus;
}

/** Public URL for an object in a corpus storage bucket. */
export function corpusFileUrl(path: string, bucket: string = CORPUS_BUCKET): string {
  return corpusClient().storage.from(bucket).getPublicUrl(path).data.publicUrl;
}

/** Signed URL (private bucket); falls back to the public URL on failure. */
export async function corpusSignedUrl(
  path: string,
  expiresIn = 3600,
  bucket: string = CORPUS_BUCKET,
): Promise<string> {
  const { data, error } = await corpusClient()
    .storage.from(bucket)
    .createSignedUrl(path, expiresIn);
  if (error || !data?.signedUrl) return corpusFileUrl(path, bucket);
  return data.signedUrl;
}
