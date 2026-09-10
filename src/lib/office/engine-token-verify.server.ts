// Verify an Office engine token this platform minted (server-only). Used when
// the engine service calls back to save a revision on the user's behalf.
import { createLocalJWKSet, jwtVerify } from "jose";

import { ENGINE_AUDIENCE, ENGINE_SCOPE, engineIssuer, engineJwks } from "./engine-token.server";

export type EngineClaims = { sub: string; doc: string; name?: string };

export async function verifyEngineToken(token: string, requestUrl: string): Promise<EngineClaims> {
  const jwks = createLocalJWKSet(await engineJwks());
  const { payload } = await jwtVerify(token, jwks, {
    issuer: engineIssuer(requestUrl),
    audience: ENGINE_AUDIENCE,
    algorithms: ["RS256"],
    clockTolerance: 5,
  });
  const scopes = new Set(String(payload["scope"] ?? "").split(" "));
  if (!payload.sub || !scopes.has(ENGINE_SCOPE) || typeof payload["doc"] !== "string") {
    throw new Error("token lacks the required claims");
  }
  return {
    sub: payload.sub,
    doc: payload["doc"],
    ...(typeof payload["name"] === "string" ? { name: payload["name"] } : {}),
  };
}
