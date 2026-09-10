// Shared helpers for the /api/writer routes: cookie auth, error mapping, and
// bounded binary bodies. Server-only.
import type { SwUser } from "@/lib/auth/cognito.server";

import { DOCX_MIME, MAX_DOCX_BYTES } from "./types";
import { WriterError } from "./writer.server";

export async function writerUser(request: Request): Promise<SwUser | Response> {
  const { getUserFromRequest } = await import("@/lib/auth/cognito.server");
  const user = await getUserFromRequest(request);
  if (!user) return Response.json({ error: "Sign in to continue." }, { status: 401 });
  return user;
}

export function writerErrorResponse(err: unknown): Response {
  if (err instanceof WriterError)
    return Response.json({ error: err.message }, { status: err.status });
  const status = Number((err as { status?: unknown })?.status);
  if (Number.isInteger(status) && status >= 400 && status < 600) {
    return Response.json({ error: (err as Error).message }, { status });
  }
  console.error("[writer] request failed:", err);
  return Response.json({ error: "The document service encountered an error." }, { status: 500 });
}

/** Read a binary body up to the DOCX cap; 413 beyond it. */
export async function readDocxBody(request: Request): Promise<Uint8Array> {
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (declared > MAX_DOCX_BYTES) throw new WriterError(413, "The document exceeds the size limit.");
  const buf = new Uint8Array(await request.arrayBuffer());
  if (buf.byteLength > MAX_DOCX_BYTES)
    throw new WriterError(413, "The document exceeds the size limit.");
  return buf;
}

export function docxResponse(
  bytes: Uint8Array,
  name: string,
  headers: Record<string, string> = {},
): Response {
  const safe = name.replace(/["\r\n\\]/g, "_");
  return new Response(bytes as unknown as BodyInit, {
    status: 200,
    headers: {
      "Content-Type": DOCX_MIME,
      "Content-Length": String(bytes.byteLength),
      "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(safe)}`,
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      ...headers,
    },
  });
}
