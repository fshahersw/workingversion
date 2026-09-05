// Chat history + memory on DynamoDB.
// Default: conversations (and their messages) auto-expire 3 days after creation
// via the table's TTL. "Save" clears the TTL to persist. Everything is
// owner-scoped: the caller passes the Cognito principal; keys embed it, so a
// user can only reach their own conversations.
import { ulid } from "ulid";

import {
  putItem,
  getItem,
  queryPrefix,
  updateItem,
  deleteItem,
  batchDelete,
} from "@/lib/data/dynamo.server";

const TTL_DAYS = Number(process.env.SW_CHAT_TTL_DAYS ?? "3");
function ttlEpoch(): number {
  return Math.floor(Date.now() / 1000) + TTL_DAYS * 86400;
}

const userPK = (p: string) => `USER#${p}`;
const convSK = (id: string) => `CONV#${id}`;
const convPK = (id: string) => `CONV#${id}`;
const msgSK = (id: string) => `MSG#${id}`;

export type Role = "user" | "assistant" | "system";
export type Conversation = {
  convId: string;
  title: string;
  saved: boolean;
  folderId?: string;
  createdAt: string;
  updatedAt: string;
};
export type Message = { msgId: string; role: Role; content: string; ts: string };

export async function createConversation(principal: string, title?: string): Promise<Conversation> {
  const convId = ulid();
  const now = new Date().toISOString();
  const name = (title ?? "").trim().slice(0, 200) || "New conversation";
  await putItem({
    PK: userPK(principal),
    SK: convSK(convId),
    entity: "conversation",
    owner: principal,
    convId,
    title: name,
    saved: false,
    createdAt: now,
    updatedAt: now,
    ttl: ttlEpoch(),
  });
  return { convId, title: name, saved: false, createdAt: now, updatedAt: now };
}

async function loadConv(principal: string, convId: string) {
  const c = await getItem(userPK(principal), convSK(convId));
  if (!c) throw new Error("Conversation not found");
  return c;
}

export async function appendMessage(
  principal: string,
  convId: string,
  role: Role,
  content: string,
): Promise<Message> {
  const conv = await loadConv(principal, convId);
  const msgId = ulid();
  const now = new Date().toISOString();
  const item: Record<string, unknown> = {
    PK: convPK(convId),
    SK: msgSK(msgId),
    entity: "message",
    convId,
    role,
    content,
    ts: now,
  };
  // Messages expire together with the conversation (unset once saved).
  if (!conv.saved && conv.ttl) item.ttl = conv.ttl;
  await putItem(item);
  await updateItem(userPK(principal), convSK(convId), { set: { updatedAt: now } });
  return { msgId, role, content, ts: now };
}

export async function listConversations(principal: string, limit = 50): Promise<Conversation[]> {
  // ULID sort keys are time-ordered; scanForward:false => most recent first.
  const rows = await queryPrefix(userPK(principal), "CONV#", { scanForward: false, limit });
  return rows.map((r) => ({
    convId: r.convId as string,
    title: r.title as string,
    saved: !!r.saved,
    folderId: r.folderId as string | undefined,
    createdAt: r.createdAt as string,
    updatedAt: r.updatedAt as string,
  }));
}

export async function getConversation(principal: string, convId: string) {
  const conv = await loadConv(principal, convId);
  const msgs = await queryPrefix(convPK(convId), "MSG#", { scanForward: true });
  return {
    conversation: {
      convId,
      title: conv.title as string,
      saved: !!conv.saved,
      folderId: conv.folderId as string | undefined,
      createdAt: conv.createdAt as string,
      updatedAt: conv.updatedAt as string,
    } as Conversation,
    messages: msgs.map((m) => ({
      msgId: (m.SK as string).slice("MSG#".length),
      role: m.role as Role,
      content: m.content as string,
      ts: m.ts as string,
    })) as Message[],
  };
}

/** Persist a conversation (clear the 3-day TTL) and optionally file it in a folder. */
export async function saveConversation(principal: string, convId: string, folderId?: string) {
  await loadConv(principal, convId);
  await updateItem(userPK(principal), convSK(convId), {
    set: { saved: true, ...(folderId ? { folderId } : {}) },
    remove: ["ttl"],
  });
  const msgs = await queryPrefix(convPK(convId), "MSG#", { scanForward: true });
  for (const m of msgs) {
    await updateItem(m.PK as string, m.SK as string, { remove: ["ttl"] });
  }
  return { ok: true, saved: true };
}

export async function deleteConversation(principal: string, convId: string) {
  await loadConv(principal, convId);
  const msgs = await queryPrefix(convPK(convId), "MSG#", { scanForward: true });
  await batchDelete(msgs.map((m) => ({ PK: m.PK as string, SK: m.SK as string })));
  await deleteItem(userPK(principal), convSK(convId));
  return { ok: true };
}

/** Save one message/output as a persisted library Item (the memory layer). */
export async function saveOutput(
  principal: string,
  convId: string,
  msgId: string,
  folderId = "ROOT",
): Promise<{ itemId: string }> {
  await loadConv(principal, convId);
  const m = await getItem(convPK(convId), msgSK(msgId));
  if (!m) throw new Error("Message not found");
  const itemId = ulid();
  const now = new Date().toISOString();
  const content = m.content as string;
  await putItem({
    PK: userPK(principal),
    SK: `ITEM#${itemId}`,
    entity: "item",
    type: "output",
    owner: principal,
    itemId,
    name: content.slice(0, 80),
    content,
    folderId,
    saved: true,
    createdAt: now,
    sourceConvId: convId,
    sourceMsgId: msgId,
    GSI1PK: `FLD#${principal}#${folderId}`,
    GSI1SK: `ITEM#${now}#${itemId}`,
  });
  return { itemId };
}
