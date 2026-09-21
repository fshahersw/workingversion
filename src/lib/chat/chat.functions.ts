// Server functions for chat history + memory, gated by requireAuth.
// Every call is scoped to the authenticated Cognito principal (context.user.sub).
// Chain order matches this app's TanStack Start version: middleware -> inputValidator -> handler.
import { createServerFn } from "@tanstack/react-start";

import { requireAuth } from "@/lib/auth/require-auth";
import type { SwUser } from "@/lib/auth/cognito.server";
import type { JsonValue } from "@/lib/chat/chat.server";

function principalOf(context: unknown): string {
  return (context as { user: SwUser }).user.sub;
}

type Role = "user" | "assistant" | "system";

export const createConversationFn = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .inputValidator((d: { title?: string }) => ({
    title: typeof d?.title === "string" ? d.title : undefined,
  }))
  .handler(async ({ context, data }) => {
    const { createConversation } = await import("@/lib/chat/chat.server");
    return createConversation(principalOf(context), data.title);
  });

export const appendMessageFn = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .inputValidator((d: { convId: string; role: Role; content: string }) => {
    if (!d?.convId || !d?.content || !d?.role) throw new Error("convId, role, content required");
    return { convId: d.convId, role: d.role, content: d.content };
  })
  .handler(async ({ context, data }) => {
    const { appendMessage } = await import("@/lib/chat/chat.server");
    return appendMessage(principalOf(context), data.convId, data.role, data.content);
  });

export const updateMessageFn = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .inputValidator((d: { convId: string; msgId: string; content: string }) => {
    if (!d?.convId || !d?.msgId || !d?.content) throw new Error("convId, msgId, content required");
    return { convId: d.convId, msgId: d.msgId, content: d.content };
  })
  .handler(async ({ context, data }) => {
    const { updateMessage } = await import("@/lib/chat/chat.server");
    return updateMessage(principalOf(context), data.convId, data.msgId, data.content);
  });

export const listConversationsFn = createServerFn({ method: "GET" })
  .middleware([requireAuth])
  .handler(async ({ context }) => {
    const { listConversations } = await import("@/lib/chat/chat.server");
    return listConversations(principalOf(context));
  });

export const getConversationFn = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .inputValidator((d: { convId: string }) => {
    if (!d?.convId) throw new Error("convId required");
    return { convId: d.convId };
  })
  .handler(async ({ context, data }) => {
    const { getConversation } = await import("@/lib/chat/chat.server");
    return getConversation(principalOf(context), data.convId);
  });

export const updateConversationStateFn = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .inputValidator(
    (d: {
      convId: string;
      memory?: JsonValue | null;
      matter?: { matterId: string; label: string } | null;
    }) => {
      if (!d?.convId) throw new Error("convId required");
      return {
        convId: d.convId,
        ...(d.memory !== undefined ? { memory: d.memory } : {}),
        ...(d.matter !== undefined ? { matter: d.matter } : {}),
      };
    },
  )
  .handler(async ({ context, data }) => {
    const { updateConversationState } = await import("@/lib/chat/chat.server");
    return updateConversationState(principalOf(context), data.convId, data);
  });

export const saveConversationFn = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .inputValidator((d: { convId: string; folderId?: string }) => {
    if (!d?.convId) throw new Error("convId required");
    return { convId: d.convId, folderId: d.folderId };
  })
  .handler(async ({ context, data }) => {
    const { saveConversation } = await import("@/lib/chat/chat.server");
    return saveConversation(principalOf(context), data.convId, data.folderId);
  });

export const deleteConversationFn = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .inputValidator((d: { convId: string }) => {
    if (!d?.convId) throw new Error("convId required");
    return { convId: d.convId };
  })
  .handler(async ({ context, data }) => {
    const { deleteConversation } = await import("@/lib/chat/chat.server");
    return deleteConversation(principalOf(context), data.convId);
  });

/** The attorney's cross-chat research memory (anchors + standing preferences).
 *  Read-only view for a settings/"what do you remember" surface. */
export const getUserMemoryFn = createServerFn({ method: "GET" })
  .middleware([requireAuth])
  .handler(async ({ context }) => {
    const { loadUserMemory } = await import("@/lib/agents/user-memory.server");
    const mem = await loadUserMemory(principalOf(context));
    return {
      anchors: mem.anchors.map((a) => ({ label: a.label, kind: a.kind, chats: a.chats, lastSeen: a.lastSeen })),
      preferences: mem.preferences.map((p) => ({ text: p.text, chats: p.chats, lastSeen: p.lastSeen })),
      updatedAt: mem.updatedAt,
    };
  });

/** Forget everything carried across chats for this attorney. Per-conversation
 *  memory (stored on each conversation) is untouched. */
export const clearUserMemoryFn = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .handler(async ({ context }) => {
    const { clearUserMemory } = await import("@/lib/agents/user-memory.server");
    await clearUserMemory(principalOf(context));
    return { ok: true as const };
  });

export const saveOutputFn = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .inputValidator((d: { convId: string; msgId: string; folderId?: string }) => {
    if (!d?.convId || !d?.msgId) throw new Error("convId, msgId required");
    return { convId: d.convId, msgId: d.msgId, folderId: d.folderId };
  })
  .handler(async ({ context, data }) => {
    const { saveOutput } = await import("@/lib/chat/chat.server");
    return saveOutput(principalOf(context), data.convId, data.msgId, data.folderId);
  });

// wired 2026-09-03
