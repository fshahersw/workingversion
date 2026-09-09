// Corpus backend client config (external HTTP project holding the corpus).
//
// The app reads the NEW `corpus` schema through public-schema bridge views
// (public.corpus_*), so the default PostgREST profile works — no
// Accept-Profile header needed. Callers use fetch() + CORPUS_SERVICE_KEY.
// Storage helpers speak the public object URL / sign API directly.
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

function storageOrigin(): string {
  return corpusUrl().replace(/\/$/, "");
}

function encodeObjectPath(path: string): string {
  return path
    .split("/")
    .filter((part) => part.length > 0)
    .map((part) => encodeURIComponent(part))
    .join("/");
}

function storageAuthKey(): string {
  const service =
    typeof process !== "undefined" ? process.env["CORPUS_SERVICE_KEY"] : undefined;
  return (service && service.trim()) || corpusConfig().key;
}

/** Public URL for an object in a corpus storage bucket. */
export function corpusFileUrl(path: string, bucket: string = CORPUS_BUCKET): string {
  return `${storageOrigin()}/storage/v1/object/public/${bucket}/${encodeObjectPath(path)}`;
}

/** Signed URL (private bucket); falls back to the public URL on failure. */
export async function corpusSignedUrl(
  path: string,
  expiresIn = 3600,
  bucket: string = CORPUS_BUCKET,
): Promise<string> {
  const key = storageAuthKey();
  try {
    const res = await fetch(
      `${storageOrigin()}/storage/v1/object/sign/${bucket}/${encodeObjectPath(path)}`,
      {
        method: "POST",
        headers: {
          apikey: key,
          Authorization: `Bearer ${key}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ expiresIn }),
      },
    );
    if (!res.ok) return corpusFileUrl(path, bucket);
    const data = (await res.json()) as { signedURL?: string; signedUrl?: string };
    const signed = data.signedURL ?? data.signedUrl;
    if (!signed) return corpusFileUrl(path, bucket);
    if (signed.startsWith("http")) return signed;
    return `${storageOrigin()}${signed.startsWith("/") ? "" : "/"}${signed}`;
  } catch {
    return corpusFileUrl(path, bucket);
  }
}
