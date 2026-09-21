import type { OfficeChatAppendInput } from "@/lib/office/chat-persistence";
// Client-callable server functions for Office documents (all kinds), gated by
// requireAuth and scoped to the authenticated Cognito principal. Binary bytes
// travel through the /api/office routes; everything JSON-shaped lives here.
import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";

import type { SwUser } from "@/lib/auth/cognito.server";
import { requireAuth } from "@/lib/auth/require-auth";

import { isDocId, isOfficeKind, type OfficeKind } from "./types";

function principalOf(context: unknown): string {
  return (context as { user: SwUser }).user.sub;
}
function userOf(context: unknown): SwUser {
  return (context as { user: SwUser }).user;
}

function requireDocId(value: unknown): string {
  if (!isDocId(value)) throw new Error("docId required");
  return value;
}

export const listOfficeDocsFn = createServerFn({ method: "GET" })
  .middleware([requireAuth])
  .inputValidator((d?: { kind?: OfficeKind }) => ({
    ...(d && isOfficeKind(d.kind) ? { kind: d.kind } : {}),
  }))
  .handler(async ({ context, data }) => {
    const { listOfficeDocs } = await import("./office.server");
    return listOfficeDocs(principalOf(context), data.kind);
  });

export const getOfficeDocFn = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .inputValidator((d: { docId: string }) => ({ docId: requireDocId(d?.docId) }))
  .handler(async ({ context, data }) => {
    const { getOfficeDoc } = await import("./office.server");
    return getOfficeDoc(principalOf(context), data.docId);
  });

export const renameOfficeDocFn = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .inputValidator((d: { docId: string; name: string }) => {
    if (typeof d?.name !== "string" || !d.name.trim()) throw new Error("name required");
    return { docId: requireDocId(d.docId), name: d.name };
  })
  .handler(async ({ context, data }) => {
    const { renameOfficeDoc } = await import("./office.server");
    return renameOfficeDoc(principalOf(context), data.docId, data.name);
  });

export const deleteOfficeDocFn = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .inputValidator((d: { docId: string }) => ({ docId: requireDocId(d?.docId) }))
  .handler(async ({ context, data }) => {
    const { deleteOfficeDoc } = await import("./office.server");
    return deleteOfficeDoc(principalOf(context), data.docId);
  });

/**
 * New blank deck. pptx-engine builds packages with Node APIs (hashing, zlib),
 * so the one-slide blank deck is produced here rather than in the browser.
 */
export const createBlankDeckFn = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .inputValidator((d?: { name?: string }) => ({
    name: typeof d?.name === "string" ? d.name : "Untitled.pptx",
  }))
  .handler(async ({ context, data }) => {
    const [{ createOfficeDoc }, { createBlankPptx }] = await Promise.all([
      import("./office.server"),
      import("@genoffice/pptx-engine"),
    ]);
    return createOfficeDoc(principalOf(context), {
      kind: "pptx",
      name: data.name,
      bytes: await createBlankPptx(),
    });
  });

// --- Assistant chat history (per document) ------------------------------------------

export const loadOfficeChatFn = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .inputValidator((d: { docId: string; limit?: number }) => ({
    docId: requireDocId(d?.docId),
    limit: Number.isFinite(d?.limit) ? Number(d.limit) : 200,
  }))
  .handler(async ({ context, data }) => {
    const { loadOfficeChat } = await import("./office.server");
    return loadOfficeChat(principalOf(context), data.docId, data.limit);
  });

export const appendOfficeChatFn = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .inputValidator((d: { docId: string; message: OfficeChatAppendInput }) => {
    const m = d?.message;
    if (!m || (m.role !== "user" && m.role !== "assistant") || typeof m.text !== "string") {
      throw new Error("message required");
    }
    return {
      docId: requireDocId(d.docId),
      message: {
        role: m.role,
        text: m.text,
        ...(typeof m.operationId === "string" ? { operationId: m.operationId } : {}),
        ...(Array.isArray(m.tools) ? { tools: m.tools } : {}),
        ...(Array.isArray(m.attachments) ? { attachments: m.attachments } : {}),
      },
    };
  })
  .handler(async ({ context, data }) => {
    const { appendOfficeChat } = await import("./office.server");
    return appendOfficeChat(principalOf(context), data.docId, data.message);
  });

// --- Engine session bootstrap ----------------------------------------------------------

/**
 * Everything the browser needs to open a document in the Office engine
 * service: the engine base URL, a token scoped to this user and document, and
 * a presigned GET for the exact revision so the engine loads the bytes without
 * bucket credentials.
 */
export const openEngineSessionFn = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .inputValidator((d: { docId: string; version?: number }) => ({
    docId: requireDocId(d?.docId),
    ...(Number.isInteger(d?.version) && Number(d.version) > 0
      ? { version: Number(d.version) }
      : {}),
  }))
  .handler(async ({ context, data }) => {
    const { grantOfficeRevision } = await import("./office.server");
    const { mintEngineToken, engineConfigured } = await import("./engine-token.server");
    if (!engineConfigured()) {
      throw new Error("The spreadsheet engine is not configured (OFFICE_ENGINE_URL).");
    }
    const request = getRequest();
    const user = userOf(context);
    const grant = await grantOfficeRevision(user.sub, data.docId, data.version);
    const token = await mintEngineToken(user, data.docId, request.url);
    return {
      engineUrl: process.env["OFFICE_ENGINE_PUBLIC_URL"] || process.env["OFFICE_ENGINE_URL"]!,
      token: token.token,
      tokenExpiresAt: token.expiresAt,
      document: {
        docId: data.docId,
        kind: grant.kind,
        name: grant.name,
        version: grant.version,
        hash: grant.hash,
      },
      source: grant.url,
    };
  });
