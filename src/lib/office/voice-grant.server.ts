import { SignJWT } from "jose";

function configuration(env: Record<string, string | undefined> = process.env) {
  if (env.OFFICE_VOICE_ENABLED !== "true")
    throw new Error(
      "Live voice is disabled until the Office voice gateway has been verified. Typed instructions remain available.",
    );
  const url = env.OFFICE_VOICE_PUBLIC_URL;
  const secret = env.OFFICE_VOICE_JWT_SECRET;
  if (!url || !secret || new TextEncoder().encode(secret).length < 32)
    throw new Error(
      "Live voice is not configured. Your administrator must connect the Office voice gateway. Typed instructions remain available.",
    );
  const target = new URL(url);
  if (
    target.username ||
    target.password ||
    target.search ||
    target.hash ||
    (target.protocol !== "wss:" &&
      !(target.protocol === "ws:" && ["localhost", "127.0.0.1", "[::1]"].includes(target.hostname)))
  )
    throw new Error("Office voice requires a secure WebSocket URL (or localhost for development).");
  return { url, secret };
}

/** A boolean only: never expose the signing configuration through a capability RPC. */
export function officeVoiceEnabled(env: Record<string, string | undefined> = process.env): boolean {
  try {
    configuration(env);
    return true;
  } catch {
    return false;
  }
}

export async function issueVoiceGrant(
  userId: string,
  binding: { app: string; document: string; mode: string },
) {
  const { url, secret } = configuration();
  const token = await new SignJWT(binding)
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(userId)
    .setIssuer("seegerweiss-platform")
    .setAudience("seegerweiss-office-voice")
    .setJti(crypto.randomUUID())
    .setIssuedAt()
    .setExpirationTime("60s")
    .sign(new TextEncoder().encode(secret));
  return { url, token };
}
