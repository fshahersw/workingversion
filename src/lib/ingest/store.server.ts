// Server-only helpers for the ingest endpoints: corpus REST bookkeeping and
// S3 presigned PUT/GET generation (SigV4, no SDK — Worker friendly).
import { CORPUS_URL, MATTERS_BUCKET } from "@/lib/corpus";
import type { Manifest, Reject } from "./schema";

const enc = new TextEncoder();

function serviceKey(): string {
  const k = process.env["CORPUS_SERVICE_KEY"];
  if (!k) throw new Error("CORPUS_SERVICE_KEY is not configured");
  return k;
}

export function requireIngestAuth(request: Request): Response | null {
  const expected = process.env["INGEST_API_KEY"];
  if (!expected) return json({ error: "ingest_disabled", message: "INGEST_API_KEY is not configured" }, 503);
  const got = request.headers.get("x-ingest-key") ?? "";
  if (got.length !== expected.length || !timingSafeEqual(got, expected)) {
    return json({ error: "unauthorized", message: "invalid or missing X-Ingest-Key" }, 401);
  }
  return null;
}

function timingSafeEqual(a: string, b: string): boolean {
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "content-type": "application/json" },
  });
}

// ------------------------------------------------------------ corpus REST --
async function rest(path: string, init: RequestInit = {}): Promise<Response> {
  const k = serviceKey();
  return fetch(`${CORPUS_URL}/rest/v1/${path}`, {
    ...init,
    headers: {
      apikey: k,
      Authorization: `Bearer ${k}`,
      "content-type": "application/json",
      ...(init.headers as Record<string, string> | undefined),
    },
  });
}

export type Batch = {
  batch_id: string;
  matter_slug: string;
  status: string;
  stage: string | null;
  counts: Record<string, unknown>;
  error: string | null;
  created_at: string;
};

export async function createBatch(m: Manifest): Promise<Batch> {
  const res = await rest("corpus_ingest_batches", {
    method: "POST",
    headers: { Prefer: "return=representation" },
    body: JSON.stringify({
      matter_slug: m.matter.slug,
      contract_version: m.contract_version,
      mode: m.batch.mode,
      idempotency_key: m.idempotency_key,
      submitted_by: m.batch.submitted_by ?? null,
      status: "open",
      manifest: m,
    }),
  });
  if (res.status === 409) throw new Error("duplicate_idempotency_key");
  if (!res.ok) throw new Error(`batch insert failed: ${res.status} ${await res.text()}`);
  const [row] = (await res.json()) as Batch[];
  return row;
}

export async function getBatch(id: string): Promise<Batch | null> {
  const res = await rest(`corpus_ingest_batches?batch_id=eq.${id}&select=*`);
  if (!res.ok) throw new Error(`batch read failed: ${res.status}`);
  const rows = (await res.json()) as Batch[];
  return rows[0] ?? null;
}

export async function updateBatch(id: string, patch: Record<string, unknown>): Promise<void> {
  const res = await rest(`corpus_ingest_batches?batch_id=eq.${id}`, {
    method: "PATCH",
    body: JSON.stringify(patch),
  });
  if (!res.ok) throw new Error(`batch update failed: ${res.status} ${await res.text()}`);
}

export async function recordRejects(batchId: string, rejects: Reject[]): Promise<void> {
  if (!rejects.length) return;
  const res = await rest("corpus_ingest_rejects", {
    method: "POST",
    body: JSON.stringify(
      rejects.slice(0, 5000).map((r) => ({
        batch_id: batchId,
        record_id: r.record_id ?? null,
        slot: r.slot ?? null,
        code: r.code,
        message: r.message,
      })),
    ),
  });
  if (!res.ok) throw new Error(`reject insert failed: ${res.status} ${await res.text()}`);
}

export async function clearRejects(batchId: string): Promise<void> {
  await rest(`corpus_ingest_rejects?batch_id=eq.${batchId}`, { method: "DELETE" });
}

export async function listRejects(batchId: string, limit = 200): Promise<Reject[]> {
  const res = await rest(`corpus_ingest_rejects?batch_id=eq.${batchId}&select=record_id,slot,code,message&limit=${limit}`);
  if (!res.ok) return [];
  return (await res.json()) as Reject[];
}

// --------------------------------------------------------------- S3 SigV4 --
async function hmac(key: ArrayBuffer | Uint8Array, msg: string): Promise<ArrayBuffer> {
  const k = await crypto.subtle.importKey("raw", key as BufferSource, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return crypto.subtle.sign("HMAC", k, enc.encode(msg));
}
const hex = (b: ArrayBuffer) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");
async function sha256Hex(s: string): Promise<string> {
  return hex(await crypto.subtle.digest("SHA-256", enc.encode(s)));
}

/**
 * Presigned S3 URL (query-string auth). `method` is PUT for uploads,
 * GET for the runner's download of the staged file.
 */
export async function presign(
  key: string,
  method: "PUT" | "GET" | "HEAD" | "DELETE",
  expiresIn = 3600,
): Promise<string> {
  const accessKey = process.env["AWS_ACCESS_KEY_ID"];
  const secret = process.env["AWS_SECRET_ACCESS_KEY"];
  const region = process.env["AWS_REGION"] ?? "us-east-1";
  const endpoint = process.env["S3_ENDPOINT"] ?? `https://s3.${region}.amazonaws.com`;
  if (!accessKey || !secret) throw new Error("AWS credentials are not configured");

  const url = new URL(endpoint);
  const host = url.host;
  // Some S3-compatible endpoints (Supabase Storage) live under a path prefix,
  // which must be part of the signed canonical URI.
  const prefix = url.pathname.replace(/\/$/, "");
  const canonicalUri = `${prefix}/${MATTERS_BUCKET}/${key.split("/").map(encodeURIComponent).join("/")}`;
  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
  const date = amzDate.slice(0, 8);
  const scope = `${date}/${region}/s3/aws4_request`;

  const params = new URLSearchParams({
    "X-Amz-Algorithm": "AWS4-HMAC-SHA256",
    "X-Amz-Credential": `${accessKey}/${scope}`,
    "X-Amz-Date": amzDate,
    "X-Amz-Expires": String(expiresIn),
    "X-Amz-SignedHeaders": "host",
  });
  const canonicalRequest = [
    method,
    canonicalUri,
    params.toString(),
    `host:${host}\n`,
    "host",
    "UNSIGNED-PAYLOAD",
  ].join("\n");
  const stringToSign = ["AWS4-HMAC-SHA256", amzDate, scope, await sha256Hex(canonicalRequest)].join("\n");

  let sig: ArrayBuffer = await hmac(enc.encode(`AWS4${secret}`), date);
  sig = await hmac(sig, region);
  sig = await hmac(sig, "s3");
  sig = await hmac(sig, "aws4_request");
  sig = await hmac(sig, stringToSign);

  params.set("X-Amz-Signature", hex(sig));
  return `${url.origin}${canonicalUri}?${params.toString()}`;
}

/**
 * Size of a staged object, or null when absent. Uses a 1-byte ranged GET:
 * Supabase's S3 gateway rejects presigned HEAD requests.
 */
export async function headObject(key: string): Promise<number | null> {
  const url = await presign(key, "GET", 300);
  const res = await fetch(url, { headers: { Range: "bytes=0-0" } });
  if (!res.ok) return null;
  const cr = res.headers.get("content-range");
  if (cr && cr.includes("/")) return Number(cr.split("/")[1]);
  return Number(res.headers.get("content-length") ?? 0);
}

export async function putText(key: string, body: string, contentType: string): Promise<void> {
  const url = await presign(key, "PUT", 900);
  const res = await fetch(url, { method: "PUT", body, headers: { "content-type": contentType } });
  if (!res.ok) throw new Error(`S3 PUT ${key} failed: ${res.status} ${await res.text()}`);
}

export async function getText(key: string): Promise<string | null> {
  const url = await presign(key, "GET", 900);
  const res = await fetch(url);
  if (!res.ok) return null;
  return res.text();
}

// ------------------------------------------------ binary + admin helpers --
export async function putBytes(key: string, body: Uint8Array, contentType: string): Promise<void> {
  const url = await presign(key, "PUT", 900);
  const res = await fetch(url, {
    method: "PUT",
    body: body as unknown as BodyInit,
    headers: { "content-type": contentType },
  });
  if (!res.ok) throw new Error(`S3 PUT ${key} failed: ${res.status} ${await res.text()}`);
}

export async function getBytes(key: string): Promise<Uint8Array | null> {
  const url = await presign(key, "GET", 900);
  const res = await fetch(url);
  if (!res.ok) return null;
  return new Uint8Array(await res.arrayBuffer());
}

export async function deleteObject(key: string): Promise<boolean> {
  const url = await presign(key, "DELETE", 300);
  const res = await fetch(url, { method: "DELETE" });
  return res.ok || res.status === 404;
}

/** Calls a corpus RPC with the service key (service_role only functions). */
export async function rpc<T>(name: string, args: Record<string, unknown>): Promise<T> {
  const res = await rest(`rpc/${name}`, { method: "POST", body: JSON.stringify(args) });
  if (!res.ok) throw new Error(`rpc ${name} failed: ${res.status} ${await res.text()}`);
  return (await res.json()) as T;
}

/** Read a corpus bridge view/table with the service key. */
export async function restSelect<T>(path: string): Promise<T> {
  const res = await rest(path);
  if (!res.ok) throw new Error(`select ${path} failed: ${res.status} ${await res.text()}`);
  return (await res.json()) as T;
}

/** Insert rows into a corpus bridge view with the service key. */
export async function restInsert<T>(
  path: string,
  rows: unknown,
  prefer = "return=representation",
): Promise<T> {
  const res = await rest(path, {
    method: "POST",
    body: JSON.stringify(rows),
    headers: { Prefer: prefer },
  });
  if (!res.ok) throw new Error(`insert ${path} failed: ${res.status} ${await res.text()}`);
  if (prefer.includes("return=minimal")) return undefined as T;
  return (await res.json()) as T;
}

/** Patch rows in a corpus bridge view with the service key. */
export async function restPatch(path: string, patch: Record<string, unknown>): Promise<void> {
  const res = await rest(path, {
    method: "PATCH",
    body: JSON.stringify(patch),
    headers: { Prefer: "return=minimal" },
  });
  if (!res.ok) throw new Error(`patch ${path} failed: ${res.status} ${await res.text()}`);
}
