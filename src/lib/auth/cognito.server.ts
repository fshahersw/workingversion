// Server-only Cognito OIDC helpers for SeegerWeissAI auth.
// Authorization-code + PKCE, session held in an httpOnly cookie (auto-sent with
// same-origin requests, so no client bearer-attacher is needed).
// Replaces Supabase auth. Microsoft Entra can be added to the SAME Cognito pool
// later (add the IdP, link by email) with no change to this module.
//
// Config is resolved on use. Production requires explicit env values; local
// development keeps the pool defaults built on 2026-09-03.
import crypto from "node:crypto";
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";

import { loadCognitoConfig } from "../config.server";

const SCOPES = "openid email profile";

let jwks: ReturnType<typeof createRemoteJWKSet> | undefined;
let jwksIssuer = "";

function remoteJwks(issuer: string): ReturnType<typeof createRemoteJWKSet> {
  if (!jwks || jwksIssuer !== issuer) {
    jwks = createRemoteJWKSet(new URL(`${issuer}/.well-known/jwks.json`));
    jwksIssuer = issuer;
  }
  return jwks;
}

// Cookie names
export const C_ID = "sw_id";
export const C_REFRESH = "sw_refresh";
export const C_PKCE = "sw_pkce";
export const C_STATE = "sw_state";
export const C_REDIRECT = "sw_redir";

function b64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function newPkce(): { verifier: string; challenge: string } {
  const verifier = b64url(crypto.randomBytes(32));
  const challenge = b64url(crypto.createHash("sha256").update(verifier).digest());
  return { verifier, challenge };
}

export function newState(): string {
  return b64url(crypto.randomBytes(16));
}

export function authorizeUrl(state: string, challenge: string): string {
  const config = loadCognitoConfig();
  const p = new URLSearchParams({
    client_id: config.clientId,
    response_type: "code",
    scope: SCOPES,
    redirect_uri: config.redirectUri,
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
  });
  return `https://${config.domain}/oauth2/authorize?${p.toString()}`;
}

export function logoutUrl(): string {
  const config = loadCognitoConfig();
  const p = new URLSearchParams({
    client_id: config.clientId,
    logout_uri: config.logoutUri,
  });
  return `https://${config.domain}/logout?${p.toString()}`;
}

type TokenResponse = {
  id_token: string;
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  token_type: string;
};

export async function exchangeCode(code: string, verifier: string): Promise<TokenResponse> {
  const config = loadCognitoConfig();
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    client_id: config.clientId,
    code,
    redirect_uri: config.redirectUri,
    code_verifier: verifier,
  });
  const res = await fetch(`https://${config.domain}/oauth2/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!res.ok) throw new Error(`token exchange failed: ${res.status} ${await res.text()}`);
  return (await res.json()) as TokenResponse;
}

export async function refreshTokens(refreshToken: string): Promise<TokenResponse> {
  const config = loadCognitoConfig();
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    client_id: config.clientId,
    refresh_token: refreshToken,
  });
  const res = await fetch(`https://${config.domain}/oauth2/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!res.ok) throw new Error(`refresh failed: ${res.status}`);
  return (await res.json()) as TokenResponse;
}

export type SwUser = {
  sub: string;
  email: string;
  name?: string;
  groups: string[];
  role: "admin" | "user";
  // Reserved for Entra federation (empty until then):
  entraOid?: string;
  tid?: string;
};

export async function verifyIdToken(idToken: string): Promise<SwUser> {
  const config = loadCognitoConfig();
  const { payload } = await jwtVerify(idToken, remoteJwks(config.issuer), {
    issuer: config.issuer,
    audience: config.clientId,
  });
  if (payload["token_use"] !== "id") throw new Error("not an id token");
  const claims = payload as JWTPayload & Record<string, unknown>;
  const groups = (claims["cognito:groups"] as string[] | undefined) ?? [];
  return {
    sub: String(payload.sub),
    email: String(claims["email"] ?? ""),
    name: claims["name"] ? String(claims["name"]) : undefined,
    groups,
    role: groups.includes("admin") ? "admin" : "user",
    entraOid: claims["custom:entra_oid"] ? String(claims["custom:entra_oid"]) : undefined,
    tid: claims["custom:tid"] ? String(claims["custom:tid"]) : undefined,
  };
}

// ---- cookies ----
export function parseCookies(header: string | null): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i === -1) continue;
    const k = part.slice(0, i).trim();
    if (!k) continue;
    out[k] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export function serializeCookie(name: string, value: string, maxAgeSec: number): string {
  const { secureCookies } = loadCognitoConfig();
  const parts = [
    `${name}=${encodeURIComponent(value)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${maxAgeSec}`,
  ];
  if (secureCookies) parts.push("Secure");
  return parts.join("; ");
}

export function clearCookie(name: string): string {
  const { secureCookies } = loadCognitoConfig();
  const parts = [`${name}=`, "Path=/", "HttpOnly", "SameSite=Lax", "Max-Age=0"];
  if (secureCookies) parts.push("Secure");
  return parts.join("; ");
}

/**
 * Read + verify the session from a request. Returns the user or null.
 * Phase 1: verifies the id_token only; if expired/invalid, returns null (the
 * user re-auths at /auth, which is silent if the Cognito/Entra session is alive).
 * Silent refresh via the refresh_token cookie is a later enhancement.
 */
export async function getUserFromRequest(request: Request): Promise<SwUser | null> {
  loadCognitoConfig();
  const idToken = parseCookies(request.headers.get("cookie"))[C_ID];
  if (!idToken) return null;
  try {
    return await verifyIdToken(idToken);
  } catch {
    return null;
  }
}

export const getCognitoConfig = loadCognitoConfig;

// Compatibility view for callers that inspect config directly. Values remain
// lazy so importing this module cannot select development infrastructure.
export const cognitoConfig = {
  get REGION() {
    return loadCognitoConfig().region;
  },
  get USER_POOL_ID() {
    return loadCognitoConfig().userPoolId;
  },
  get CLIENT_ID() {
    return loadCognitoConfig().clientId;
  },
  get DOMAIN() {
    return loadCognitoConfig().domain;
  },
  get REDIRECT_URI() {
    return loadCognitoConfig().redirectUri;
  },
  get LOGOUT_URI() {
    return loadCognitoConfig().logoutUri;
  },
  get ISSUER() {
    return loadCognitoConfig().issuer;
  },
  get SECURE() {
    return loadCognitoConfig().secureCookies;
  },
  SCOPES,
};
