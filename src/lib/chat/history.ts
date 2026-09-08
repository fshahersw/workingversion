// Drop-in replacement for the old Supabase `research-history`, backed by the AWS
// Cognito + DynamoDB chat backend (server fns in chat.functions.ts). Same
// exports and signatures, so callers (use-chat, ConversationHistory) only change
// their import path.
//
// Default behavior: conversations + messages auto-expire 3 days after creation
// (DynamoDB TTL). `keepConversation` clears the TTL to persist ("save as ongoing").
//
// v1 notes: conversation "memory" and matter are not persisted across reloads
// (carried in-session); follow-ups are not persisted. The rich assistant message
// (answer/rounds/sources/followups) is stored as JSON so a reopened conversation
// renders faithfully.
import type { MatterScope, Message, Round, Source } from "@/lib/chat-types";
import {
  createConversationFn,
  appendMessageFn,
  listConversationsFn,
  getConversationFn,
  saveConversationFn,
  deleteConversationFn,
} from "@/lib/chat/chat.functions";

export type ConversationSummary = {
  id: string;
  title: string;
  matterLabel: string | null;
  updatedAt: string;
  saved: boolean;
};

export type LoadedConversation = {
  id: string;
  title: string;
  matter: MatterScope | null;
  memory: unknown;
  messages: Message[];
};

function titleFrom(question: string): string {
  const t = question.replace(/\s+/g, " ").trim();
  return (t.length > 80 ? `${t.slice(0, 77)}…` : t) || "New research";
}

export async function listConversations(limit = 30): Promise<ConversationSummary[]> {
  try {
    const rows = await listConversationsFn();
    return rows.slice(0, limit).map((c) => ({
      id: c.convId,
      title: c.title || "New research",
      matterLabel: null,
      updatedAt: c.updatedAt,
      saved: !!c.saved,
    }));
  } catch {
    return [];
  }
}

export async function loadConversation(id: string): Promise<LoadedConversation | null> {
  try {
    const loaded = await getConversationFn({ data: { convId: id } });
    if (!loaded?.conversation) return null;
    const messages: Message[] = loaded.messages.map((m) => {
      if (m.role === "assistant") {
        let parsed: { answer?: string; rounds?: Round[]; sources?: Source[]; followups?: string[] } | null = null;
        try {
          parsed = JSON.parse(m.content);
        } catch {
          parsed = null;
        }
        return {
          id: crypto.randomUUID(),
          role: "assistant",
          text: "",
          answer: parsed?.answer ?? m.content,
          rounds: parsed?.rounds ?? [],
          sources: parsed?.sources ?? [],
          followups: parsed?.followups ?? [],
          status: "done" as const,
        };
      }
      return {
        id: crypto.randomUUID(),
        role: "user",
        text: m.content,
        answer: "",
        rounds: [],
        sources: [],
        followups: [],
        status: "done" as const,
      };
    });
    return {
      id: loaded.conversation.convId,
      title: loaded.conversation.title || "New research",
      matter: null,
      memory: null,
      messages,
    };
  } catch {
    return null;
  }
}

/** Delete a conversation and its messages. Returns false when the server refused. */
export async function deleteConversation(id: string): Promise<boolean> {
  try {
    await deleteConversationFn({ data: { convId: id } });
    return true;
  } catch {
    return false;
  }
}

/**
 * Persists one completed question/answer pair, creating the conversation on the
 * first turn. Returns the conversation id. Failures are swallowed — saving
 * history must never interrupt chat. The conversation keeps its 3-day TTL until
 * the user explicitly keeps it (see keepConversation).
 */
export async function saveTurn(args: {
  conversationId: string | null;
  question: Message;
  answer: Message;
  memory: unknown;
  matter: MatterScope | null;
  turnIndex: number;
}): Promise<string | null> {
  try {
    let conversationId = args.conversationId;
    if (!conversationId) {
      const c = await createConversationFn({ data: { title: titleFrom(args.question.text) } });
      conversationId = c.convId;
    }
    await appendMessageFn({
      data: { convId: conversationId, role: "user", content: args.question.text },
    });
    const assistantPayload = JSON.stringify({
      answer: args.answer.answer ?? "",
      rounds: args.answer.rounds ?? [],
      sources: args.answer.sources ?? [],
      followups: args.answer.followups ?? [],
    });
    await appendMessageFn({
      data: { convId: conversationId, role: "assistant", content: assistantPayload },
    });
    return conversationId;
  } catch {
    return args.conversationId;
  }
}

/** v1: follow-ups are not persisted (they regenerate on demand). */
export async function saveFollowups(
  _conversationId: string | null,
  _clientId: string,
  _followups: string[],
): Promise<void> {
  return;
}

/** Persist a conversation past the 3-day default by clearing its TTL. */
export async function keepConversation(id: string, folderId?: string): Promise<void> {
  try {
    await saveConversationFn({ data: { convId: id, folderId } });
  } catch {
    /* best-effort */
  }
}
