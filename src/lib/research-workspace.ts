import { supabase } from "@/integrations/supabase/client";
import type { MatterScope, Source } from "@/lib/chat-types";

/**
 * Research workspace persistence: saved answers, pinned passages, watched
 * topics and their hits, and the saved prompt library.
 *
 * Everything runs through the browser Supabase client under RLS, so a user
 * only ever reads or writes their own rows.
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

async function uid(): Promise<string | null> {
  const { data } = await supabase.auth.getUser();
  return data.user?.id ?? null;
}

/* ------------------------------------------------------------------ answers */

export async function saveAnswer(args: {
  conversationId: string | null;
  matter: MatterScope | null;
  question: string;
  answer: string;
  sources: Source[];
}): Promise<string | null> {
  const userId = await uid();
  if (!userId) return null;
  const { data, error } = await supabase
    .from("research_saved_answers")
    .insert({
      user_id: userId,
      conversation_id: args.conversationId,
      matter_id: args.matter?.matterId ?? null,
      matter_label: args.matter?.label ?? null,
      question: args.question,
      answer: args.answer,
      sources: args.sources as never,
    })
    .select("id")
    .single();
  if (error || !data) return null;
  return data.id as string;
}

export async function listSavedAnswers(matterId?: string): Promise<SavedAnswer[]> {
  let q = supabase
    .from("research_saved_answers")
    .select("id, question, answer, matter_label, created_at")
    .order("created_at", { ascending: false })
    .limit(50);
  if (matterId) q = q.eq("matter_id", matterId);
  const { data, error } = await q;
  if (error || !data) return [];
  return data.map((r) => ({
    id: r.id as string,
    question: (r.question as string) ?? "",
    answer: (r.answer as string) ?? "",
    matterLabel: (r.matter_label as string | null) ?? null,
    createdAt: r.created_at as string,
  }));
}

export async function deleteSavedAnswer(id: string): Promise<void> {
  await supabase.from("research_saved_answers").delete().eq("id", id);
}

/* --------------------------------------------------------------------- pins */

export async function addPin(args: {
  conversationId: string | null;
  matter: MatterScope | null;
  quote: string;
  note?: string;
  source?: Source | null;
}): Promise<Pin | null> {
  const userId = await uid();
  if (!userId) return null;
  const { data, error } = await supabase
    .from("research_pins")
    .insert({
      user_id: userId,
      conversation_id: args.conversationId,
      matter_id: args.matter?.matterId ?? null,
      quote: args.quote,
      note: args.note ?? null,
      source_ref: args.source?.ref ?? null,
      citation: args.source?.citation ?? null,
      source_url: args.source?.source_url ?? null,
    })
    .select("id, quote, note, source_ref, citation, source_url, created_at")
    .single();
  if (error || !data) return null;
  return rowToPin(data);
}

export async function listPins(conversationId?: string | null): Promise<Pin[]> {
  let q = supabase
    .from("research_pins")
    .select("id, quote, note, source_ref, citation, source_url, created_at")
    .order("created_at", { ascending: false })
    .limit(100);
  if (conversationId) q = q.eq("conversation_id", conversationId);
  const { data, error } = await q;
  if (error || !data) return [];
  return data.map(rowToPin);
}

export async function deletePin(id: string): Promise<void> {
  await supabase.from("research_pins").delete().eq("id", id);
}

function rowToPin(r: Record<string, unknown>): Pin {
  return {
    id: r.id as string,
    quote: (r.quote as string) ?? "",
    note: (r.note as string | null) ?? null,
    sourceRef: (r.source_ref as string | null) ?? null,
    citation: (r.citation as string | null) ?? null,
    sourceUrl: (r.source_url as string | null) ?? null,
    createdAt: r.created_at as string,
  };
}

/* ------------------------------------------------------------------ watches */

export async function saveWatch(args: {
  question: string;
  label?: string;
  matter: MatterScope | null;
  sources: Source[];
}): Promise<string | null> {
  const userId = await uid();
  if (!userId) return null;
  const seen = args.sources
    .map((s) => s.source_url)
    .filter((u): u is string => Boolean(u));
  const { data, error } = await supabase
    .from("research_watches")
    .insert({
      user_id: userId,
      question: args.question,
      label: args.label || shorten(args.question),
      matter_id: args.matter?.matterId ?? null,
      matter_label: args.matter?.label ?? null,
      seen_urls: seen as never,
    })
    .select("id")
    .single();
  if (error || !data) return null;
  return data.id as string;
}

export async function listWatches(): Promise<Watch[]> {
  const [watches, hits] = await Promise.all([
    supabase
      .from("research_watches")
      .select("id, question, label, matter_label, active, last_checked_at")
      .order("updated_at", { ascending: false })
      .limit(50),
    supabase
      .from("research_watch_hits")
      .select("watch_id, seen")
      .eq("seen", false),
  ]);
  if (watches.error || !watches.data) return [];
  const unseen = new Map<string, number>();
  for (const h of hits.data ?? []) {
    const k = h.watch_id as string;
    unseen.set(k, (unseen.get(k) ?? 0) + 1);
  }
  return watches.data.map((r) => ({
    id: r.id as string,
    question: (r.question as string) ?? "",
    label: (r.label as string) || shorten((r.question as string) ?? ""),
    matterLabel: (r.matter_label as string | null) ?? null,
    active: Boolean(r.active),
    lastCheckedAt: (r.last_checked_at as string | null) ?? null,
    unseen: unseen.get(r.id as string) ?? 0,
  }));
}

export async function deleteWatch(id: string): Promise<void> {
  await supabase.from("research_watches").delete().eq("id", id);
}

export async function setWatchActive(id: string, active: boolean): Promise<void> {
  await supabase.from("research_watches").update({ active }).eq("id", id);
}

export async function listWatchHits(watchId: string): Promise<WatchHit[]> {
  const { data, error } = await supabase
    .from("research_watch_hits")
    .select("id, watch_id, title, summary, url, source_label, published_at, seen, created_at")
    .eq("watch_id", watchId)
    .order("created_at", { ascending: false })
    .limit(50);
  if (error || !data) return [];
  return data.map((r) => ({
    id: r.id as string,
    watchId: r.watch_id as string,
    title: (r.title as string) ?? "",
    summary: (r.summary as string | null) ?? null,
    url: (r.url as string | null) ?? null,
    sourceLabel: (r.source_label as string | null) ?? null,
    publishedAt: (r.published_at as string | null) ?? null,
    seen: Boolean(r.seen),
    createdAt: r.created_at as string,
  }));
}

export async function markWatchHitsSeen(watchId: string): Promise<void> {
  await supabase
    .from("research_watch_hits")
    .update({ seen: true })
    .eq("watch_id", watchId)
    .eq("seen", false);
}

export async function countUnseenHits(): Promise<number> {
  const { count } = await supabase
    .from("research_watch_hits")
    .select("id", { count: "exact", head: true })
    .eq("seen", false);
  return count ?? 0;
}

/* ------------------------------------------------------------------ prompts */

export async function listPrompts(): Promise<SavedPrompt[]> {
  const { data, error } = await supabase
    .from("research_prompts")
    .select("id, title, prompt")
    .order("created_at", { ascending: false })
    .limit(50);
  if (error || !data) return [];
  return data.map((r) => ({
    id: r.id as string,
    title: (r.title as string) ?? "",
    prompt: (r.prompt as string) ?? "",
  }));
}

export async function savePrompt(title: string, prompt: string): Promise<void> {
  const userId = await uid();
  if (!userId) return;
  await supabase
    .from("research_prompts")
    .insert({ user_id: userId, title: title || shorten(prompt), prompt });
}

export async function deletePrompt(id: string): Promise<void> {
  await supabase.from("research_prompts").delete().eq("id", id);
}

export function shorten(text: string, max = 70): string {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}
