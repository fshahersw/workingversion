// ============================================================================
// Per-user cross-chat research memory — persistence (server-only).
//
// One DynamoDB item per attorney: PK USER#<sub> / SK MEMORY#research. Owner
// scoped by construction (the key embeds the verified Cognito principal). The
// profile is small (see user-memory.ts budgets), never contains conversation
// content, and is read with a hard time cap so a slow table can never delay a
// research turn: on timeout or error the turn proceeds without it.
//
// Kill switch: RESEARCH_USER_MEMORY=off disables both read and write.
// ============================================================================
import { deleteItem, getItem, putItem } from "@/lib/data/dynamo.server";
import { listConversations } from "@/lib/chat/chat.server";

import { agentError, agentLog, trunc } from "./log.server";
import {
  emptyUserMemory,
  mergeUserMemory,
  normalizeUserMemory,
  userContextBlock,
  type RecentChat,
  type SessionLedger,
  type UserMemory,
} from "./user-memory";

const PK = (sub: string) => `USER#${sub}`;
const SK = "MEMORY#research";
/** Loading must never hold up the turn; past this the turn runs without it. */
const LOAD_CAP_MS = Number(process.env["RESEARCH_USER_MEMORY_LOAD_MS"] ?? "450");
const RECENT_CHATS = 6;

export function userMemoryEnabled(
  env: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
  return !/^(0|off|false|no)$/i.test(env["RESEARCH_USER_MEMORY"]?.trim() ?? "");
}

function withCap<T>(work: Promise<T>, ms: number, fallback: T): Promise<T> {
  return new Promise<T>((resolve) => {
    const timer = setTimeout(() => resolve(fallback), ms);
    work.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      () => {
        clearTimeout(timer);
        resolve(fallback);
      },
    );
  });
}

export async function loadUserMemory(sub: string): Promise<UserMemory> {
  if (!sub || !userMemoryEnabled()) return emptyUserMemory();
  try {
    const item = await getItem(PK(sub), SK);
    return normalizeUserMemory(item?.["profile"]);
  } catch (err) {
    agentError("user_memory_load_failed", { error: trunc(String(err), 160) });
    return emptyUserMemory();
  }
}

export type UserContext = {
  memory: UserMemory;
  recent: RecentChat[];
  /** Prompt block, or "" when there is nothing worth injecting. */
  block: string;
};

/**
 * Everything the research turn needs from the cross-chat layer, gathered in
 * parallel and capped at LOAD_CAP_MS total. `excludeTitle` drops the current
 * conversation from the recent-chat list (its title is the first question).
 */
export async function loadUserContext(
  sub: string,
  opts?: { excludeConversationId?: string },
): Promise<UserContext> {
  const empty: UserContext = { memory: emptyUserMemory(), recent: [], block: "" };
  if (!sub || !userMemoryEnabled()) return empty;
  const started = Date.now();
  const [memory, recent] = await Promise.all([
    withCap(loadUserMemory(sub), LOAD_CAP_MS, emptyUserMemory()),
    withCap(
      listConversations(sub, RECENT_CHATS + 1).then((rows) =>
        rows
          .filter((r) => !opts?.excludeConversationId || r.convId !== opts.excludeConversationId)
          .slice(0, RECENT_CHATS)
          .map((r) => ({ title: r.title, updatedAt: r.updatedAt })),
      ),
      LOAD_CAP_MS,
      [] as RecentChat[],
    ),
  ]);
  const block = userContextBlock(memory, recent, new Date());
  agentLog("user_memory_load", {
    ms: Date.now() - started,
    anchors: memory.anchors.length,
    recent: recent.length,
    block_chars: block.length,
  });
  return { memory, recent, block };
}

/**
 * Fold a conversation's refreshed ledger into the durable profile. Best-effort
 * and off the critical path: callers do not await it for the answer. A single
 * conversation counts once no matter how many turns it has.
 */
export async function recordUserMemory(
  sub: string,
  conversationId: string | null | undefined,
  ledger: SessionLedger,
): Promise<void> {
  if (!sub || !userMemoryEnabled()) return;
  if (!ledger.entities.length && !ledger.preferences.length) return;
  try {
    const prev = await loadUserMemory(sub);
    const next = mergeUserMemory(prev, ledger, conversationId || "unknown");
    await putItem({
      PK: PK(sub),
      SK,
      entity: "user_memory",
      owner: sub,
      profile: next,
      updatedAt: next.updatedAt,
    });
  } catch (err) {
    agentError("user_memory_record_failed", { error: trunc(String(err), 160) });
  }
}

/** Attorney-initiated reset. */
export async function clearUserMemory(sub: string): Promise<void> {
  if (!sub) return;
  await deleteItem(PK(sub), SK);
}
