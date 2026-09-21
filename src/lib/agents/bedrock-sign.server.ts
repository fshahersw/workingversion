// ============================================================================
// SigV4 signing for Bedrock (server-only).
//
// Replaces the old AWS_BEARER_TOKEN_BEDROCK static-key auth. Every Bedrock
// request is signed with SigV4 using the default AWS credential chain — SSO in
// dev (the same identity our DynamoDB/S3 clients use), a scoped IAM role in
// prod. No long-lived secrets.
//
// We keep the existing raw-HTTPS transport (and its retry/backoff/streaming
// parsing) intact: this just produces the signed headers and calls fetch, so
// callers swap `Authorization: Bearer` for `signedBedrockFetch` with no other
// change. Streaming endpoints work unchanged — only the request is signed.
// ============================================================================
import { Sha256 } from "@aws-crypto/sha256-js";
import { defaultProvider } from "@aws-sdk/credential-provider-node";
import { HttpRequest } from "@smithy/protocol-http";
import { SignatureV4 } from "@smithy/signature-v4";

import { loadBedrockRegion } from "../config.server";
import { localSyntheticEnabled } from "../local-development";

// One signer per AWS region/service pair (e.g. "bedrock-agentcore").
const _signers = new Map<string, SignatureV4>();
function signer(service: string, regionOverride?: string): SignatureV4 {
  const region = regionOverride || loadBedrockRegion();
  const key = `${region}:${service}`;
  let s = _signers.get(key);
  if (!s) {
    s = new SignatureV4({
      service,
      region,
      // Default chain: SSO profile in dev, container/instance role in prod.
      credentials: defaultProvider(),
      sha256: Sha256,
    });
    _signers.set(key, s);
  }
  return s;
}

/**
 * SigV4-sign a request for an arbitrary AWS service and fetch it. `body` is the
 * exact JSON string sent (also hashed for the signature). Any headers passed
 * are signed too (e.g. a streaming `accept` or `MCP-Protocol-Version` header).
 */
export async function signedAwsFetch(
  service: string,
  url: string,
  opts: {
    method?: string;
    body: string;
    headers?: Record<string, string>;
    signal?: AbortSignal;
    /** Sign for a region other than the configured Bedrock region (the URL's host must match). */
    region?: string;
  },
): Promise<Response> {
  if (localSyntheticEnabled()) throw new Error("This AWS-backed capability is unavailable in the local synthetic workspace.");
  const u = new URL(url);
  const request = new HttpRequest({
    method: opts.method ?? "POST",
    protocol: u.protocol,
    hostname: u.hostname,
    path: u.pathname,
    query: Object.fromEntries(u.searchParams),
    headers: {
      host: u.hostname,
      "content-type": "application/json",
      ...(opts.headers ?? {}),
    },
    body: opts.body,
  });
  const signed = await signer(service, opts.region).sign(request);
  return fetch(url, {
    method: request.method,
    headers: signed.headers,
    body: opts.body,
    ...(opts.signal ? { signal: opts.signal } : {}),
  });
}

/** SigV4-sign a Bedrock (data-plane) request and fetch it. */
export async function signedBedrockFetch(
  url: string,
  opts: {
    method?: string;
    body: string;
    headers?: Record<string, string>;
    signal?: AbortSignal;
    region?: string;
  },
): Promise<Response> {
  return signedAwsFetch("bedrock", url, opts);
}

/**
 * Bedrock is now always the transport when running server-side: SigV4 resolves
 * credentials from the default chain at call time. Kept as a function so the
 * existing `bedrockEnabled()` / `bedrockClaudeEnabled()` gates keep their shape.
 */
export function bedrockCredsReady(): boolean {
  return true;
}

// --- Retry policy shared across Bedrock calls (stream + non-stream) ----------
// Robust under concurrency (many users): throttling (429) and transient 5xx are
// retried with FULL-JITTER exponential backoff — jitter so a burst of throttled
// callers doesn't retry in lockstep (thundering herd) — honoring a server-sent
// Retry-After when present.

/** Initial attempt + this many retries. */
export const BEDROCK_MAX_RETRIES = 4;

/** Throttling, transient server errors, and network failures (status 0). */
export function isRetryableBedrockStatus(status: number): boolean {
  return status === 0 || status === 429 || status >= 500;
}

/** Parse a Retry-After header (seconds) into ms, if present and valid. */
export function retryAfterMsFrom(res: Response): number | undefined {
  const h = res.headers.get("retry-after");
  if (!h) return undefined;
  const secs = Number(h);
  return Number.isFinite(secs) && secs > 0 ? secs * 1000 : undefined;
}

/** Backoff for a 0-based attempt: honor Retry-After when given (capped 15s),
 *  else full-jitter exponential capped at 12s. */
export function bedrockRetryDelayMs(attempt: number, retryAfterMs?: number): number {
  if (retryAfterMs && retryAfterMs > 0) return Math.min(retryAfterMs, 15_000);
  const cap = Math.min(1_000 * 2 ** attempt, 12_000);
  return Math.floor(Math.random() * cap);
}
