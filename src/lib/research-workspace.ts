import type { MatterScope, Source } from "@/lib/chat-types";

/**
 * Research workspace persistence for the current browser tab only.
 * Pins, watches, saved answers, and prompts used to live on the retired
 * Supabase project. They no longer leave the process.
 */

export type SavedAnswer = {
  id: string;
  question: string;
  answer: string;
  matterLabel: string | null;
  createdAt: string;
};

export type Pin = {
  id: string;
  quote: string;
  note: string | null;
  sourceRef: string | null;
  citation: string | null;
  sourceUrl: string | null;
  createdAt: string;
};

export type Watch = {
  id: string;
  question: string;
  label: string;
  matterLabel: string | null;
  active: boolean;
  lastCheckedAt: string | null;
  unseen: number;
};

export type WatchHit = {
  id: string;
  watchId: string;
  title: string;
  summary: string | null;
  url: string | null;
  sourceLabel: string | null;
  publishedAt: string | null;
  seen: boolean;
  createdAt: string;
};

export type SavedPrompt = {
  id: string;
  title: string;
  prompt: string;
};

type StoredAnswer = SavedAnswer & { matterId: string | null; conversationId: string | null };
type StoredPin = Pin & { conversationId: string | null };
type StoredWatch = Watch;
type StoredHit = WatchHit;

const answers: StoredAnswer[] = [];
const pins: StoredPin[] = [];
const watches: StoredWatch[] = [];
const hits: StoredHit[] = [];
const prompts: SavedPrompt[] = [];

function id(): string {
  return crypto.randomUUID();
}

function now(): string {
  return new Date().toISOString();
}

/* ------------------------------------------------------------------ answers */

export async function saveAnswer(args: {
  conversationId: string | null;
  matter: MatterScope | null;
  question: string;
  answer: string;
  sources: Source[];
}): Promise<string | null> {
  void args.sources;
  const row: StoredAnswer = {
    id: id(),
    question: args.question,
    answer: args.answer,
    matterLabel: args.matter?.label ?? null,
    createdAt: now(),
    matterId: args.matter?.matterId ?? null,
    conversationId: args.conversationId,
  };
  answers.unshift(row);
  return row.id;
}

export async function listSavedAnswers(matterId?: string): Promise<SavedAnswer[]> {
  return answers
    .filter((r) => !matterId || r.matterId === matterId)
    .slice(0, 50)
    .map(({ id, question, answer, matterLabel, createdAt }) => ({
      id,
      question,
      answer,
      matterLabel,
      createdAt,
    }));
}

export async function deleteSavedAnswer(rowId: string): Promise<void> {
  const i = answers.findIndex((r) => r.id === rowId);
  if (i >= 0) answers.splice(i, 1);
}

/* --------------------------------------------------------------------- pins */

export async function addPin(args: {
  conversationId: string | null;
  matter: MatterScope | null;
  quote: string;
  note?: string;
  source?: Source | null;
}): Promise<Pin | null> {
  void args.matter;
  const row: StoredPin = {
    id: id(),
    quote: args.quote,
    note: args.note ?? null,
    sourceRef: args.source?.ref ?? null,
    citation: args.source?.citation ?? null,
    sourceUrl: args.source?.source_url ?? null,
    createdAt: now(),
    conversationId: args.conversationId,
  };
  pins.unshift(row);
  return row;
}

export async function listPins(conversationId?: string | null): Promise<Pin[]> {
  return pins
    .filter((p) => !conversationId || p.conversationId === conversationId)
    .slice(0, 100)
    .map(({ conversationId: _c, ...pin }) => pin);
}

export async function deletePin(rowId: string): Promise<void> {
  const i = pins.findIndex((p) => p.id === rowId);
  if (i >= 0) pins.splice(i, 1);
}

/* ------------------------------------------------------------------ watches */

export async function saveWatch(args: {
  question: string;
  label?: string;
  matter: MatterScope | null;
  sources: Source[];
}): Promise<string | null> {
  void args.sources;
  const row: StoredWatch = {
    id: id(),
    question: args.question,
    label: args.label || shorten(args.question),
    matterLabel: args.matter?.label ?? null,
    active: true,
    lastCheckedAt: null,
    unseen: 0,
  };
  watches.unshift(row);
  return row.id;
}

export async function listWatches(): Promise<Watch[]> {
  const unseen = new Map<string, number>();
  for (const h of hits) {
    if (!h.seen) unseen.set(h.watchId, (unseen.get(h.watchId) ?? 0) + 1);
  }
  return watches.slice(0, 50).map((w) => ({ ...w, unseen: unseen.get(w.id) ?? 0 }));
}

export async function deleteWatch(rowId: string): Promise<void> {
  const i = watches.findIndex((w) => w.id === rowId);
  if (i >= 0) watches.splice(i, 1);
  for (let j = hits.length - 1; j >= 0; j--) {
    if (hits[j]?.watchId === rowId) hits.splice(j, 1);
  }
}

export async function setWatchActive(rowId: string, active: boolean): Promise<void> {
  const row = watches.find((w) => w.id === rowId);
  if (row) row.active = active;
}

export async function listWatchHits(watchId: string): Promise<WatchHit[]> {
  return hits.filter((h) => h.watchId === watchId).slice(0, 50);
}

export async function markWatchHitsSeen(watchId: string): Promise<void> {
  for (const h of hits) {
    if (h.watchId === watchId) h.seen = true;
  }
}

export async function countUnseenHits(): Promise<number> {
  return hits.filter((h) => !h.seen).length;
}

/* ------------------------------------------------------------------ prompts */

export async function listPrompts(): Promise<SavedPrompt[]> {
  return prompts.slice(0, 50);
}

export async function savePrompt(title: string, prompt: string): Promise<void> {
  prompts.unshift({
    id: id(),
    title: title || shorten(prompt),
    prompt,
  });
}

export async function deletePrompt(rowId: string): Promise<void> {
  const i = prompts.findIndex((p) => p.id === rowId);
  if (i >= 0) prompts.splice(i, 1);
}

export function shorten(text: string, max = 70): string {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}
