// Shared helpers for the /api/office routes: cookie or engine-token auth,
// error mapping, and bounded binary bodies. Server-only.
import type { SwUser } from "@/lib/auth/cognito.server";

import { MAX_OFFICE_BYTES, OFFICE_MIME, type OfficeKind } from "./types";
import { OfficeError } from "./office.server";

/**
 * Resolve the caller: the platform session cookie (browser), or a Bearer engine
 * token (the Office engine service saving on the user's behalf). Engine tokens
 * are the ones this platform minted; they carry the user's sub and the docId
 * they are scoped to.
 */
export async function officeUser(
  request: Request,
  scope?: { docId: string },
): Promise<SwUser | Response> {
  const auth = request.headers.get("authorization") ?? "";
  if (auth.startsWith("Bearer ")) {
    const { verifyEngineToken } = await import("./engine-token-verify.server");
    const claims = await verifyEngineToken(auth.slice(7), request.url).catch(() => null);
    if (!claims)
      return Response.json({ error: "The engine token is invalid or expired." }, { status: 401 });
    if (scope && claims.doc !== scope.docId) {
      return Response.json(
        { error: "The engine token is not scoped to this document." },
        { status: 403 },
      );
    }
    return { sub: claims.sub, email: "", name: claims.name, groups: [], role: "user" };
  }
  const { getUserFromRequest } = await import("@/lib/auth/cognito.server");
  const user = await getUserFromRequest(request);
  if (!user) return Response.json({ error: "Sign in to continue." }, { status: 401 });
  return user;
}

export function officeErrorResponse(err: unknown): Response {
  if (err instanceof OfficeError)
    return Response.json({ error: err.message }, { status: err.status });
  const status = Number((err as { status?: unknown })?.status);
  if (Number.isInteger(status) && status >= 400 && status < 600) {
    return Response.json({ error: (err as Error).message }, { status });
  }
  console.error("[office] request failed:", err);
  return Response.json({ error: "The document service encountered an error." }, { status: 500 });
}

/** Read a binary body up to the package cap; 413 beyond it. */
export async function readPackageBody(request: Request): Promise<Uint8Array> {
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (declared > MAX_OFFICE_BYTES)
    throw new OfficeError(413, "The document exceeds the size limit.");
  const buf = new Uint8Array(await request.arrayBuffer());
  if (buf.byteLength > MAX_OFFICE_BYTES)
    throw new OfficeError(413, "The document exceeds the size limit.");
  return buf;
}

export function packageResponse(
  bytes: Uint8Array,
  name: string,
  kind: OfficeKind,
  headers: Record<string, string> = {},
): Response {
  const safe = name.replace(/["\r\n\\]/g, "_");
  return new Response(bytes as unknown as BodyInit, {
    status: 200,
    headers: {
      "Content-Type": OFFICE_MIME[kind],
      "Content-Length": String(bytes.byteLength),
      "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(safe)}`,
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      ...headers,
    },
  });
}
