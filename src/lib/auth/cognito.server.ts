// Server-only Cognito OIDC helpers for SeegerWeissAI auth.
// Authorization-code + PKCE, session held in an httpOnly cookie (auto-sent with
// same-origin requests, so no client bearer-attacher is needed).
// Replaces Supabase auth. Microsoft Entra can be added to the SAME Cognito pool
// later (add the IdP, link by email) with no change to this module.
//
// Config comes from env with dev defaults baked in (the pool built 2026-09-03).
import crypto from "node:crypto";
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";

const REGION = process.env.COGNITO_REGION ?? "us-east-1";
const USER_POOL_ID = process.env.COGNITO_USER_POOL_ID ?? "us-east-1_D7NX6OyAR";
const CLIENT_ID = process.env.COGNITO_CLIENT_ID ?? "3ab10qboajkm0vc36lcv59k78m";
const DOMAIN = process.env.COGNITO_DOMAIN ?? "seegerweissai-auth.auth.us-east-1.amazoncognito.com";
const REDIRECT_URI = process.env.COGNITO_REDIRECT_URI ?? "http://localhost:8080/auth/callback";
const LOGOUT_URI = process.env.COGNITO_LOGOUT_URI ?? "http://localhost:8080/";
const SCOPES = "openid email profile";

const ISSUER = `https://cognito-idp.${REGION}.amazonaws.com/${USER_POOL_ID}`;
const JWKS = createRemoteJWKSet(new URL(`${ISSUER}/.well-known/jwks.json`));

// Secure cookies only over https (dev is http://localhost).
const SECURE = REDIRECT_URI.startsWith("https://");

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
  const p = new URLSearchParams({
    client_id: CLIENT_ID,
    response_type: "code",
    scope: SCOPES,
    redirect_uri: REDIRECT_URI,
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
  });
  return `https://${DOMAIN}/oauth2/authorize?${p.toString()}`;
}

export function logoutUrl(): string {
  const p = new URLSearchParams({ client_id: CLIENT_ID, logout_uri: LOGOUT_URI });
  return `https://${DOMAIN}/logout?${p.toString()}`;
}

type TokenResponse = {
  id_token: string;
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  token_type: string;
};

export async function exchangeCode(code: string, verifier: string): Promise<TokenResponse> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    client_id: CLIENT_ID,
    code,
    redirect_uri: REDIRECT_URI,
    code_verifier: verifier,
  });
  const res = await fetch(`https://${DOMAIN}/oauth2/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!res.ok) throw new Error(`token exchange failed: ${res.status} ${await res.text()}`);
  return (await res.json()) as TokenResponse;
}

export async function refreshTokens(refreshToken: string): Promise<TokenResponse> {
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    client_id: CLIENT_ID,
    refresh_token: refreshToken,
  });
  const res = await fetch(`https://${DOMAIN}/oauth2/token`, {
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
  const { payload } = await jwtVerify(idToken, JWKS, { issuer: ISSUER, audience: CLIENT_ID });
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
  const parts = [
    `${name}=${encodeURIComponent(value)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${maxAgeSec}`,
  ];
  if (SECURE) parts.push("Secure");
  return parts.join("; ");
}

export function clearCookie(name: string): string {
  const parts = [`${name}=`, "Path=/", "HttpOnly", "SameSite=Lax", "Max-Age=0"];
  if (SECURE) parts.push("Secure");
  return parts.join("; ");
}

/**
 * Read + verify the session from a request. Returns the user or null.
 * Phase 1: verifies the id_token only; if expired/invalid, returns null (the
 * user re-auths at /auth, which is silent if the Cognito/Entra session is alive).
 * Silent refresh via the refresh_token cookie is a later enhancement.
 */
export async function getUserFromRequest(request: Request): Promise<SwUser | null> {
  const idToken = parseCookies(request.headers.get("cookie"))[C_ID];
  if (!idToken) return null;
  try {
    return await verifyIdToken(idToken);
  } catch {
    return null;
  }
}

export const cognitoConfig = {
  REGION, USER_POOL_ID, CLIENT_ID, DOMAIN, REDIRECT_URI, LOGOUT_URI, ISSUER, SECURE, SCOPES,
};
