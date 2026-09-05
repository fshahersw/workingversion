// Minimal SigV4 presigner for GET object URLs (Web Crypto, Worker-safe).

const enc = new TextEncoder();

async function hmac(keyData: ArrayBuffer | Uint8Array, msg: string): Promise<ArrayBuffer> {
  const key = await crypto.subtle.importKey(
    "raw",
    keyData as BufferSource,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return crypto.subtle.sign("HMAC", key, enc.encode(msg));
}

const hex = (buf: ArrayBuffer) =>
  [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");

async function sha256Hex(msg: string): Promise<string> {
  return hex(await crypto.subtle.digest("SHA-256", enc.encode(msg)));
}

const encodeKey = (k: string) =>
  k
    .split("/")
    .map((seg) => encodeURIComponent(seg))
    .join("/");

/**
 * Presign any GET against the bucket. `objectKey` empty means a bucket-level
 * request (used for ListObjectsV2); `extra` adds request query parameters that
 * must participate in the signature.
 */
export async function presignS3(
  bucket: string,
  objectKey: string,
  extra: Record<string, string> = {},
  expiresIn = 900,
  method: "GET" | "PUT" = "GET",
): Promise<string> {
  const accessKey = process.env["AWS_ACCESS_KEY_ID"];
  const secretKey = process.env["AWS_SECRET_ACCESS_KEY"];
  const region = process.env["AWS_REGION"] || "us-east-1";
  const endpoint = process.env["S3_ENDPOINT"];
  if (!accessKey || !secretKey) throw new Error("Object storage credentials not configured");

  // Custom endpoint (Supabase Storage S3, R2, MinIO) or default AWS S3 host.
  const stripped = (endpoint ?? `https://s3.${region}.amazonaws.com`)
    .replace(/^https?:\/\//, "")
    .replace(/\/$/, "");
  const slash = stripped.indexOf("/");
  const host = slash === -1 ? stripped : stripped.slice(0, slash);
  const basePath = slash === -1 ? "" : stripped.slice(slash);
  const canonicalUri = objectKey
    ? `${basePath}/${encodeURIComponent(bucket)}/${encodeKey(objectKey)}`
    : `${basePath}/${encodeURIComponent(bucket)}`;

  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
  const dateStamp = amzDate.slice(0, 8);
  const scope = `${dateStamp}/${region}/s3/aws4_request`;

  const query = new URLSearchParams({
    ...extra,
    "X-Amz-Algorithm": "AWS4-HMAC-SHA256",
    "X-Amz-Credential": `${accessKey}/${scope}`,
    "X-Amz-Date": amzDate,
    "X-Amz-Expires": String(expiresIn),
    "X-Amz-SignedHeaders": "host",
  });
  const canonicalQuery = [...query.entries()]
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .sort()
    .join("&");

  const canonicalRequest = [
    method,
    canonicalUri,
    canonicalQuery,
    `host:${host}\n`,
    "host",
    "UNSIGNED-PAYLOAD",
  ].join("\n");

  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    scope,
    await sha256Hex(canonicalRequest),
  ].join("\n");

  let signingKey = await hmac(enc.encode(`AWS4${secretKey}`), dateStamp);
  signingKey = await hmac(signingKey, region);
  signingKey = await hmac(signingKey, "s3");
  signingKey = await hmac(signingKey, "aws4_request");
  const signature = hex(await hmac(signingKey, stringToSign));

  return `https://${host}${canonicalUri}?${canonicalQuery}&X-Amz-Signature=${signature}`;
}

export const presignS3Get = (bucket: string, objectKey: string, expiresIn = 900) =>
  presignS3(bucket, objectKey, {}, expiresIn);

export const presignS3Put = (bucket: string, objectKey: string, expiresIn = 900) =>
  presignS3(bucket, objectKey, {}, expiresIn, "PUT");

/** Fetch and parse a JSON object from the bucket. Returns null when absent. */
export async function s3GetJson<T>(bucket: string, objectKey: string): Promise<T | null> {
  const url = await presignS3(bucket, objectKey, {}, 300);
  const res = await fetch(url);
  if (res.status === 404 || res.status === 403) return null;
  if (!res.ok) throw new Error(`S3 ${bucket}/${objectKey}: ${res.status}`);
  return (await res.json()) as T;
}

export type S3Object = { key: string; size: number };

/** ListObjectsV2 under a prefix (follows continuation tokens up to `max`). */
export async function s3List(bucket: string, prefix: string, max = 2000): Promise<S3Object[]> {
  const out: S3Object[] = [];
  let token: string | undefined;
  do {
    const q: Record<string, string> = { "list-type": "2", prefix, "max-keys": "1000" };
    if (token) q["continuation-token"] = token;
    const res = await fetch(await presignS3(bucket, "", q, 300));
    if (!res.ok) {
      if (res.status === 404 || res.status === 403) return out;
      throw new Error(`S3 list ${bucket}/${prefix}: ${res.status}`);
    }
    const xml = await res.text();
    for (const m of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
      const body = m[1] ?? "";
      const key = /<Key>([\s\S]*?)<\/Key>/.exec(body)?.[1];
      const size = Number(/<Size>(\d+)<\/Size>/.exec(body)?.[1] ?? 0);
      if (key) out.push({ key, size });
    }
    token = /<NextContinuationToken>([\s\S]*?)<\/NextContinuationToken>/.exec(xml)?.[1];
  } while (token && out.length < max);
  return out;
}

