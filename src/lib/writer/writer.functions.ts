import type { OfficeChatAppendInput } from "@/lib/office/chat-persistence";
// Client-callable server functions for Writer documents, gated by requireAuth
// and scoped to the authenticated Cognito principal. Binary document bytes go
// through the /api/writer routes; everything JSON-shaped lives here.
import { createServerFn } from "@tanstack/react-start";

import type { SwUser } from "@/lib/auth/cognito.server";
import { requireAuth } from "@/lib/auth/require-auth";

import { isDraftId } from "./types";

function principalOf(context: unknown): string {
  return (context as { user: SwUser }).user.sub;
}

function requireDraftId(value: unknown): string {
  if (!isDraftId(value)) throw new Error("draftId required");
  return value;
}

export const listWriterDocsFn = createServerFn({ method: "GET" })
  .middleware([requireAuth])
  .handler(async ({ context }) => {
    const { listWriterDocs } = await import("./writer.server");
    return listWriterDocs(principalOf(context));
  });

export const getWriterDocFn = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .inputValidator((d: { draftId: string }) => ({ draftId: requireDraftId(d?.draftId) }))
  .handler(async ({ context, data }) => {
    const { getWriterDoc } = await import("./writer.server");
    return getWriterDoc(principalOf(context), data.draftId);
  });

export const renameWriterDocFn = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .inputValidator((d: { draftId: string; name: string }) => {
    if (typeof d?.name !== "string" || !d.name.trim()) throw new Error("name required");
    return { draftId: requireDraftId(d.draftId), name: d.name };
  })
  .handler(async ({ context, data }) => {
    const { renameWriterDoc } = await import("./writer.server");
    return renameWriterDoc(principalOf(context), data.draftId, data.name);
  });

export const deleteWriterDocFn = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .inputValidator((d: { draftId: string }) => ({ draftId: requireDraftId(d?.draftId) }))
  .handler(async ({ context, data }) => {
    const { deleteWriterDoc } = await import("./writer.server");
    return deleteWriterDoc(principalOf(context), data.draftId);
  });

// --- Assistant chat history (per document) ------------------------------------------

export const loadWriterChatFn = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .inputValidator((d: { draftId: string; limit?: number }) => ({
    draftId: requireDraftId(d?.draftId),
    limit: Number.isFinite(d?.limit) ? Number(d.limit) : 200,
  }))
  .handler(async ({ context, data }) => {
    const { loadWriterChat } = await import("./writer.server");
    return loadWriterChat(principalOf(context), data.draftId, data.limit);
  });

export const appendWriterChatFn = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .inputValidator((d: { draftId: string; message: OfficeChatAppendInput }) => {
    const m = d?.message;
    if (!m || (m.role !== "user" && m.role !== "assistant") || typeof m.text !== "string") {
      throw new Error("message required");
    }
    return {
      draftId: requireDraftId(d.draftId),
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
    const { appendWriterChat } = await import("./writer.server");
    return appendWriterChat(principalOf(context), data.draftId, data.message);
  });

// --- Web search for the Writer's web_search tool ------------------------------------

export const writerWebSearchFn = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .inputValidator((d: { query: string; maxResults?: number }) => {
    if (typeof d?.query !== "string" || !d.query.trim()) throw new Error("query required");
    return {
      query: d.query,
      maxResults: Number.isFinite(d.maxResults) ? Number(d.maxResults) : 6,
    };
  })
  .handler(async ({ data }) => {
    const { writerWebSearch } = await import("./web-search.server");
    return writerWebSearch(data.query, data.maxResults);
  });
