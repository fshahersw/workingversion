// ============================================================================
// Per-user research memory that persists ACROSS chats (pure logic).
//
// The session memory (memory.server.ts) is scoped to one conversation. This
// layer keeps a small, durable profile per attorney so a new chat starts with
// the anchors they have been working on and the standing preferences they
// keep repeating, without replaying any conversation content:
//
//   anchors      – matters / MDLs / courts / judges / statutes seen in recent
//                  chats, with how many chats and how recently
//   preferences  – standing instructions repeated across chats (or phrased as
//                  durable: "always", "from now on", "by default")
//
// Deliberately NOT stored: parties (individual plaintiffs), dates, summaries,
// questions, answers, sources. Nothing here is document or patient content.
// The server wrapper (user-memory.server.ts) owns persistence and flags.
// ============================================================================

export type UserAnchor = {
  label: string;
  /** matter | court | judge | statute */
  kind: string;
  /** Distinct conversations this anchor appeared in. */
  chats: number;
  /** ISO timestamp of the last conversation that touched it. */
  lastSeen: string;
  /** Conversation id that last counted, so one chat cannot inflate `chats`. */
  lastChat: string;
};

export type UserPreference = {
  text: string;
  chats: number;
  lastSeen: string;
  lastChat: string;
};

export type UserMemory = {
  version: 1;
  anchors: UserAnchor[];
  preferences: UserPreference[];
  updatedAt: string;
};

export const USER_MEMORY_MAX_ANCHORS = 16;
export const USER_MEMORY_MAX_PREFERENCES = 12;
export const USER_MEMORY_ANCHOR_CHARS = 160;
export const USER_MEMORY_PREFERENCE_CHARS = 140;
/** Anchors untouched for this long fall out of the profile. */
export const USER_MEMORY_STALE_DAYS = 90;
/** Ceiling for the block injected into a prompt (~230 tokens). */
export const USER_CONTEXT_CHARS = 900;

/** Entity kinds promoted from a session ledger into the durable profile. */
const ANCHOR_KINDS = new Set(["matter", "court", "judge", "statute"]);

/** A preference phrased as standing applies across chats even when seen once. */
const DURABLE_PREFERENCE_RE =
  /\b(always|never|from now on|by default|going forward|in (?:every|all) (?:answer|response|chat)s?|whenever|every time|prefer)\b/i;

/** Placeholder chat key for a turn that arrived before the chat had an id. */
const UNKNOWN_CHAT = "unknown";

const s = (v: unknown) => (typeof v === "string" ? v.trim() : "");
const clip = (t: string, n: number) => (t.length > n ? `${t.slice(0, n - 1)}…` : t);

export function emptyUserMemory(now = new Date()): UserMemory {
  return { version: 1, anchors: [], preferences: [], updatedAt: now.toISOString() };
}

function isoOr(v: unknown, fallback: string): string {
  const t = s(v);
  return t && !Number.isNaN(Date.parse(t)) ? t : fallback;
}

/** Normalizes a stored/unknown value into a budgeted profile. */
export function normalizeUserMemory(raw: unknown, now = new Date()): UserMemory {
  const m = (raw ?? {}) as Record<string, unknown>;
  const nowIso = now.toISOString();
  const anchors: UserAnchor[] = [];
  const seenA = new Set<string>();
  if (Array.isArray(m["anchors"])) {
    for (const a of m["anchors"] as Record<string, unknown>[]) {
      const label = clip(s(a?.["label"]), USER_MEMORY_ANCHOR_CHARS);
      const kind = s(a?.["kind"]);
      if (!label || !ANCHOR_KINDS.has(kind)) continue;
      const key = label.toLowerCase();
      if (seenA.has(key)) continue;
      seenA.add(key);
      anchors.push({
        label,
        kind,
        chats: Math.max(1, Math.floor(Number(a["chats"]) || 1)),
        lastSeen: isoOr(a["lastSeen"], nowIso),
        lastChat: clip(s(a["lastChat"]), 64),
      });
    }
  }
  const preferences: UserPreference[] = [];
  const seenP = new Set<string>();
  if (Array.isArray(m["preferences"])) {
    for (const p of m["preferences"] as Record<string, unknown>[]) {
      const text = clip(s(p?.["text"]), USER_MEMORY_PREFERENCE_CHARS);
      if (!text) continue;
      const key = text.toLowerCase();
      if (seenP.has(key)) continue;
      seenP.add(key);
      preferences.push({
        text,
        chats: Math.max(1, Math.floor(Number(p["chats"]) || 1)),
        lastSeen: isoOr(p["lastSeen"], nowIso),
        lastChat: clip(s(p["lastChat"]), 64),
      });
    }
  }
  return {
    version: 1,
    anchors: rankAnchors(anchors, now).slice(0, USER_MEMORY_MAX_ANCHORS),
    preferences: rankPreferences(preferences).slice(0, USER_MEMORY_MAX_PREFERENCES),
    updatedAt: isoOr(m["updatedAt"], nowIso),
  };
}

function ageDays(iso: string, now: Date): number {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return Number.POSITIVE_INFINITY;
  return Math.max(0, (now.getTime() - t) / 86_400_000);
}

/** Recency first, then breadth (how many chats). Stale anchors are dropped. */
function rankAnchors(anchors: UserAnchor[], now: Date): UserAnchor[] {
  return anchors
    .filter((a) => ageDays(a.lastSeen, now) <= USER_MEMORY_STALE_DAYS)
    .sort((a, b) => {
      const byTime = Date.parse(b.lastSeen) - Date.parse(a.lastSeen);
      return byTime !== 0 ? byTime : b.chats - a.chats;
    });
}

function rankPreferences(prefs: UserPreference[]): UserPreference[] {
  return [...prefs].sort((a, b) => {
    const byChats = b.chats - a.chats;
    return byChats !== 0 ? byChats : Date.parse(b.lastSeen) - Date.parse(a.lastSeen);
  });
}

export type SessionLedger = {
  entities: { label: string; kind: string }[];
  preferences: string[];
};

/**
 * Fold one conversation's current ledger into the profile. Idempotent per
 * conversation: calling it again for the same `conversationId` refreshes
 * `lastSeen` but does not increment `chats`, so a long chat counts once.
 */
export function mergeUserMemory(
  prev: UserMemory,
  ledger: SessionLedger,
  conversationId: string,
  now = new Date(),
): UserMemory {
  const nowIso = now.toISOString();
  const conv = clip(s(conversationId), 64) || UNKNOWN_CHAT;
  // The first turn of a chat has no id yet (the server assigns one when the
  // turn is saved), so an entry last touched by an id-less turn belongs to the
  // chat that now names itself: adopt the id, do not count a new chat. When
  // in doubt the count stays low, so a one-off instruction is never promoted
  // to a standing preference by the same chat naming itself twice.
  const sameChat = (lastChat: string) => lastChat === conv || lastChat === UNKNOWN_CHAT;

  const anchors = new Map<string, UserAnchor>();
  for (const a of prev.anchors) anchors.set(a.label.toLowerCase(), { ...a });
  for (const e of ledger.entities) {
    const label = clip(s(e.label), USER_MEMORY_ANCHOR_CHARS);
    const kind = s(e.kind);
    if (!label || !ANCHOR_KINDS.has(kind)) continue;
    const key = label.toLowerCase();
    const cur = anchors.get(key);
    if (!cur) {
      anchors.set(key, { label, kind, chats: 1, lastSeen: nowIso, lastChat: conv });
    } else {
      anchors.set(key, {
        ...cur,
        kind: cur.kind || kind,
        chats: sameChat(cur.lastChat) ? cur.chats : cur.chats + 1,
        lastSeen: nowIso,
        lastChat: conv,
      });
    }
  }

  const prefs = new Map<string, UserPreference>();
  for (const p of prev.preferences) prefs.set(p.text.toLowerCase(), { ...p });
  for (const raw of ledger.preferences) {
    const text = clip(s(raw), USER_MEMORY_PREFERENCE_CHARS);
    if (!text) continue;
    const key = text.toLowerCase();
    const cur = prefs.get(key);
    if (!cur) {
      prefs.set(key, { text, chats: 1, lastSeen: nowIso, lastChat: conv });
    } else {
      prefs.set(key, {
        ...cur,
        chats: sameChat(cur.lastChat) ? cur.chats : cur.chats + 1,
        lastSeen: nowIso,
        lastChat: conv,
      });
    }
  }

  return {
    version: 1,
    anchors: rankAnchors([...anchors.values()], now).slice(0, USER_MEMORY_MAX_ANCHORS),
    preferences: rankPreferences([...prefs.values()]).slice(0, USER_MEMORY_MAX_PREFERENCES),
    updatedAt: nowIso,
  };
}

/** Preferences worth carrying into a NEW chat: repeated, or phrased as standing. */
export function standingPreferences(mem: UserMemory): string[] {
  return mem.preferences
    .filter((p) => p.chats >= 2 || DURABLE_PREFERENCE_RE.test(p.text))
    .map((p) => p.text);
}

function relativeAge(iso: string, now: Date): string {
  const d = ageDays(iso, now);
  if (!Number.isFinite(d)) return "";
  if (d < 1) return "today";
  if (d < 2) return "yesterday";
  if (d < 14) return `${Math.floor(d)}d ago`;
  if (d < 60) return `${Math.floor(d / 7)}w ago`;
  return `${Math.floor(d / 30)}mo ago`;
}

export type RecentChat = { title: string; updatedAt: string };

/**
 * The compact block injected ahead of the session memory. Background only:
 * the wording tells the model not to assume the current question is about any
 * of it. Returns "" when there is nothing useful to say.
 */
export function userContextBlock(
  mem: UserMemory,
  recent: RecentChat[] = [],
  now = new Date(),
  opts?: { excludeTitle?: string; maxAnchors?: number; maxRecent?: number },
): string {
  const maxAnchors = opts?.maxAnchors ?? 6;
  const maxRecent = opts?.maxRecent ?? 4;
  const lines: string[] = [];

  const anchors = rankAnchors(mem.anchors, now).slice(0, maxAnchors);
  if (anchors.length) {
    lines.push(
      `Recent anchors: ${anchors
        .map((a) => {
          const age = relativeAge(a.lastSeen, now);
          const meta = [a.chats > 1 ? `${a.chats} chats` : "", age].filter(Boolean).join(", ");
          return meta ? `${a.label} (${meta})` : a.label;
        })
        .join("; ")}`,
    );
  }

  const prefs = standingPreferences(mem).slice(0, 5);
  if (prefs.length) lines.push(`Standing preferences: ${prefs.join("; ")}`);

  const exclude = s(opts?.excludeTitle).toLowerCase();
  const chats = recent
    .map((c) => ({ title: clip(s(c.title).replace(/\s+/g, " "), 80), updatedAt: c.updatedAt }))
    .filter(
      (c) =>
        c.title &&
        c.title.toLowerCase() !== exclude &&
        !/^new (research|conversation|chat)$/i.test(c.title),
    )
    .slice(0, maxRecent);
  if (chats.length) {
    lines.push(
      `Recent chats: ${chats
        .map((c) => {
          const age = relativeAge(c.updatedAt, now);
          return age ? `"${c.title}" (${age})` : `"${c.title}"`;
        })
        .join("; ")}`,
    );
  }

  if (!lines.length) return "";
  const block = [
    "ATTORNEY CONTEXT FROM EARLIER CHATS (background only — do not assume this question concerns any of it unless the question says so; use it to resolve a bare reference or to match a standing preference)",
    ...lines,
  ].join("\n");
  return block.length > USER_CONTEXT_CHARS ? `${block.slice(0, USER_CONTEXT_CHARS - 1)}…` : block;
}
