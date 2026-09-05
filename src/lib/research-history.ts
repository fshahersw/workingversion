import { supabase } from "@/integrations/supabase/client";
import type { MatterScope, Message, Round, Source } from "@/lib/chat-types";

/**
 * Saved research conversations.
 *
 * Everything here runs through the browser Supabase client under RLS, so a
 * user can only ever read or write their own rows.
 */

export type ConversationSummary = {
  id: string;
  title: string;
  matterLabel: string | null;
  updatedAt: string;
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

async function currentUserId(): Promise<string | null> {
  const { data } = await supabase.auth.getUser();
  return data.user?.id ?? null;
}

export async function listConversations(
  limit = 30,
): Promise<ConversationSummary[]> {
  const { data, error } = await supabase
    .from("research_conversations")
    .select("id, title, matter_label, updated_at")
    .order("updated_at", { ascending: false })
    .limit(limit);
  if (error || !data) return [];
  return data.map((r) => ({
    id: r.id as string,
    title: (r.title as string) || "New research",
    matterLabel: (r.matter_label as string | null) ?? null,
    updatedAt: r.updated_at as string,
  }));
}

export async function loadConversation(
  id: string,
): Promise<LoadedConversation | null> {
  const [conv, msgs] = await Promise.all([
    supabase
      .from("research_conversations")
      .select("id, title, matter_id, matter_label, memory")
      .eq("id", id)
      .maybeSingle(),
    supabase
      .from("research_messages")
      .select("id, client_id, role, text, answer, rounds, sources, followups, seq")
      .eq("conversation_id", id)
      .order("seq", { ascending: true }),
  ]);
  if (conv.error || !conv.data) return null;
  const rows = msgs.data ?? [];
  return {
    id: conv.data.id as string,
    title: (conv.data.title as string) || "New research",
    matter: conv.data.matter_id
      ? {
          matterId: conv.data.matter_id as string,
          label: (conv.data.matter_label as string) ?? "",
        }
      : null,
    memory: conv.data.memory ?? null,
    messages: rows.map((r) => ({
      id: (r.client_id as string) || (r.id as string),
      role: r.role as "user" | "assistant",
      text: (r.text as string) ?? "",
      answer: (r.answer as string) ?? "",
      rounds: (r.rounds as unknown as Round[]) ?? [],
      sources: (r.sources as unknown as Source[]) ?? [],
      followups: (r.followups as unknown as string[]) ?? [],
      status: "done" as const,
    })),
  };
}

export async function deleteConversation(id: string): Promise<void> {
  await supabase.from("research_conversations").delete().eq("id", id);
}

/**
 * Persists one completed question/answer pair, creating the conversation on
 * the first turn. Returns the conversation id so the caller can keep writing
 * to the same thread. Failures are swallowed — saving history must never
 * interrupt research.
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
    const userId = await currentUserId();
    if (!userId) return args.conversationId;

    let conversationId = args.conversationId;
    if (!conversationId) {
      const { data, error } = await supabase
        .from("research_conversations")
        .insert({
          user_id: userId,
          title: titleFrom(args.question.text),
          matter_id: args.matter?.matterId ?? null,
          matter_label: args.matter?.label ?? null,
          memory: (args.memory ?? {}) as never,
        })
        .select("id")
        .single();
      if (error || !data) return null;
      conversationId = data.id as string;
    } else {
      await supabase
        .from("research_conversations")
        .update({ memory: (args.memory ?? {}) as never, updated_at: new Date().toISOString() })
        .eq("id", conversationId);
    }

    const base = {
      conversation_id: conversationId,
      user_id: userId,
    };
    await supabase.from("research_messages").upsert(
      [
        {
          ...base,
          client_id: args.question.id,
          role: "user",
          text: args.question.text,
          seq: args.turnIndex * 2,
        },
        {
          ...base,
          client_id: args.answer.id,
          role: "assistant",
          text: "",
          answer: args.answer.answer,
          rounds: (args.answer.rounds ?? []) as never,
          sources: (args.answer.sources ?? []) as never,
          followups: (args.answer.followups ?? []) as never,
          seq: args.turnIndex * 2 + 1,
        },
      ],
      { onConflict: "conversation_id,client_id" },
    );
    return conversationId;
  } catch {
    return args.conversationId;
  }
}

/** Updates only the follow-up chips once they arrive after the answer. */
export async function saveFollowups(
  conversationId: string | null,
  clientId: string,
  followups: string[],
): Promise<void> {
  if (!conversationId) return;
  try {
    await supabase
      .from("research_messages")
      .update({ followups: followups as never })
      .eq("conversation_id", conversationId)
      .eq("client_id", clientId);
  } catch {
    /* history is best-effort */
  }
}
