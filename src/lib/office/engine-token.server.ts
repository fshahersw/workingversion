// ============================================================================
// Office engine tokens (server-only). The browser talks to the Office engine
// service (ECS) with a short-lived RS256 JWT minted here from the user's
// Cognito session. The engine verifies it against this platform's JWKS
// (/api/public/office/jwks) using its existing platform-jwt mode: issuer, audience,
// tenant claim and required scope. No Cognito secret or bucket credential
// ever reaches the engine.
//
// Key material, in order of precedence:
//   1. OFFICE_ENGINE_JWT_SECRET_ARN: a Secrets Manager secret holding
//      {"privateKeyPem": PKCS#8 PEM, "kid": key id}, read once per process
//      with SigV4 (Lambda environment variables are capped at 4 KB, so the
//      PEM never travels as a variable).
//   2. OFFICE_ENGINE_JWT_PRIVATE_KEY (PKCS#8 PEM) + OFFICE_ENGINE_JWT_KID.
//   3. Local development only: an ephemeral key pair per process, fine for one
//      dev server and one local engine, refused in production (each Lambda
//      instance would otherwise sign with a different key).
// ============================================================================
import { exportJWK, generateKeyPair, importPKCS8, SignJWT, type JWK, type KeyLike } from "jose";

import { signedAwsFetch } from "@/lib/agents/bedrock-sign.server";
import type { SwUser } from "@/lib/auth/cognito.server";

export const ENGINE_AUDIENCE =
  process.env["OFFICE_ENGINE_JWT_AUDIENCE"] || "seegerweiss-office-engine";
export const ENGINE_TENANT = process.env["OFFICE_ENGINE_TENANT"] || "seegerweiss";
export const ENGINE_SCOPE = "office:write";
const TOKEN_TTL_SECONDS = 15 * 60;

type Signer = { key: KeyLike; kid: string; publicJwk: JWK };
let signerPromise: Promise<Signer> | undefined;

export function engineIssuer(requestUrl: string): string {
  const configured = process.env["OFFICE_ENGINE_JWT_ISSUER"];
  if (configured) return configured;
  const u = new URL(requestUrl);
  return `${u.protocol}//${u.host}`;
}

export function engineConfigured(): boolean {
  return Boolean(process.env["OFFICE_ENGINE_URL"]);
}

/** Read {privateKeyPem, kid} from Secrets Manager with the runtime role (SigV4, no SDK client needed). */
async function loadSigningSecret(arn: string): Promise<{ pem: string; kid: string }> {
  const region = arn.split(":")[3] || "us-east-1";
  const res = await signedAwsFetch(
    "secretsmanager",
    `https://secretsmanager.${region}.amazonaws.com/`,
    {
      body: JSON.stringify({ SecretId: arn }),
      headers: {
        "content-type": "application/x-amz-json-1.1",
        "x-amz-target": "secretsmanager.GetSecretValue",
      },
      region,
    },
  );
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`Office engine signing key could not be read [${res.status}]: ${detail.slice(0, 200)}`);
  }
  const { SecretString } = (await res.json()) as { SecretString?: string };
  const parsed = JSON.parse(SecretString ?? "{}") as { privateKeyPem?: string; kid?: string };
  if (!parsed.privateKeyPem) throw new Error("Office engine signing secret has no privateKeyPem.");
  return { pem: parsed.privateKeyPem, kid: parsed.kid || "office-engine-1" };
}

async function signer(): Promise<Signer> {
  if (!signerPromise) {
    signerPromise = (async () => {
      let pem = process.env["OFFICE_ENGINE_JWT_PRIVATE_KEY"];
      let kid = process.env["OFFICE_ENGINE_JWT_KID"] || "office-engine-1";
      const secretArn = process.env["OFFICE_ENGINE_JWT_SECRET_ARN"];
      if (secretArn) ({ pem, kid } = await loadSigningSecret(secretArn));
      if (pem) {
        const key = await importPKCS8(pem.replace(/\\n/g, "\n"), "RS256");
        const publicJwk = await exportJWK(key);
        // exportJWK of a private key includes private members; keep only the public part.
        const {
          d: _d,
          p: _p,
          q: _q,
          dp: _dp,
          dq: _dq,
          qi: _qi,
          ...pub
        } = publicJwk as JWK & Record<string, unknown>;
        return { key, kid, publicJwk: { ...pub, kid, use: "sig", alg: "RS256" } as JWK };
      }
      if (process.env["NODE_ENV"] === "production") {
        throw new Error(
          "OFFICE_ENGINE_JWT_SECRET_ARN or OFFICE_ENGINE_JWT_PRIVATE_KEY is required in production.",
        );
      }
      const pair = await generateKeyPair("RS256", { modulusLength: 2048 });
      const publicJwk = await exportJWK(pair.publicKey);
      const devKid = `dev-${Date.now()}`;
      return {
        key: pair.privateKey,
        kid: devKid,
        publicJwk: { ...publicJwk, kid: devKid, use: "sig", alg: "RS256" },
      };
    })();
    // A transient failure (secret read, throttling) must not poison the
    // process: drop the cached rejection so the next request retries.
    signerPromise.catch(() => {
      signerPromise = undefined;
    });
  }
  return signerPromise;
}

/** Public JWKS the engine service fetches to verify tokens. */
export async function engineJwks(): Promise<{ keys: JWK[] }> {
  const s = await signer();
  return { keys: [s.publicJwk] };
}

/** Mint a token scoped to one user and one document. */
export async function mintEngineToken(
  user: SwUser,
  docId: string,
  requestUrl: string,
): Promise<{ token: string; expiresAt: number }> {
  const s = await signer();
  const now = Math.floor(Date.now() / 1000);
  const exp = now + TOKEN_TTL_SECONDS;
  const token = await new SignJWT({
    scope: ENGINE_SCOPE,
    tenant: ENGINE_TENANT,
    name: user.name || user.email || "Workspace user",
    doc: docId,
    token_use: "access",
  })
    .setProtectedHeader({ alg: "RS256", kid: s.kid })
    .setIssuer(engineIssuer(requestUrl))
    .setAudience(ENGINE_AUDIENCE)
    .setSubject(user.sub)
    .setIssuedAt(now)
    .setExpirationTime(exp)
    .setJti(crypto.randomUUID())
    .sign(s.key);
  return { token, expiresAt: exp * 1000 };
}
