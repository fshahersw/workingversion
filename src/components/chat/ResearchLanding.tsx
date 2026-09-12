import { useEffect, useState } from "react";
import { ArrowRight, Bookmark, Clock3, Lock } from "lucide-react";

import { hostOf } from "@/lib/host";
import { Favicon } from "./Favicon";
import { SkillForm } from "./SkillMenu";
import { RESEARCH_SKILLS, type ResearchSkill } from "@/lib/research-skills";
import { listConversations, type ConversationSummary } from "@/lib/chat/history";
import { listItemsFn, getLibraryItemFn } from "@/lib/library/library.functions";
import { loadResearchBriefFn } from "@/lib/research-brief.functions";
import type { ResearchHeadline } from "@/lib/research-brief";

const TTL_MS = 3 * 24 * 60 * 60 * 1000;

function relativeTime(iso: string): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "";
  const mins = Math.max(0, Math.round((Date.now() - t) / 60_000));
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.round(hrs / 24);
  return `${days}d ago`;
}

function expiryLabel(row: ConversationSummary): string | null {
  if (row.saved) return "Saved";
  const start = Date.parse(row.createdAt || row.updatedAt);
  if (!Number.isFinite(start)) return "Expires in 3d";
  const left = start + TTL_MS - Date.now();
  if (left <= 0) return "Expiring";
  const days = Math.max(1, Math.ceil(left / (24 * 60 * 60 * 1000)));
  return `Expires in ${days}d`;
}

function publishedLabel(raw?: string): string | null {
  if (!raw) return null;
  const t = Date.parse(raw);
  if (!Number.isFinite(t)) return raw.slice(0, 10);
  return new Date(t).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export function ResearchLanding({
  onSend,
  onPrefill,
  onOpenConversation,
  skill,
  onSkill,
}: {
  onSend: (text: string) => void;
  onPrefill: (text: string) => void;
  onOpenConversation: (id: string) => void;
  skill: ResearchSkill | null;
  onSkill: (skill: ResearchSkill | null) => void;
}) {
  const [convos, setConvos] = useState<ConversationSummary[] | null>(null);
  const [prompts, setPrompts] = useState<{ itemId: string; name: string; preview?: string }[]>([]);
  const [headlines, setHeadlines] = useState<ResearchHeadline[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    listConversations(8)
      .then((rows) => {
        if (!cancelled) setConvos(rows);
      })
      .catch(() => {
        if (!cancelled) setConvos([]);
      });
    listItemsFn({ data: { kind: "prompt" } })
      .then((rows) => {
        if (cancelled) return;
        setPrompts(
          rows.slice(0, 8).map((r) => ({
            itemId: r.itemId,
            name: r.name,
            preview: r.preview,
          })),
        );
      })
      .catch(() => {
        if (!cancelled) setPrompts([]);
      });
    loadResearchBriefFn()
      .then((rows) => {
        if (!cancelled) setHeadlines(rows);
      })
      .catch(() => {
        if (!cancelled) setHeadlines([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Not a hook (the `use` prefix would make the linter treat it as one):
  // fetches the saved prompt's full text and drops it into the composer.
  async function applyPrompt(itemId: string, fallback: string) {
    try {
      const full = await getLibraryItemFn({ data: { itemId } });
      onPrefill((full?.content || fallback).trim());
    } catch {
      onPrefill(fallback);
    }
  }

  return (
    <div className="mt-6 flex w-full flex-col gap-6">
      <section>
        <p className="mb-2 px-0.5 text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
          Skills
          <span className="ml-2 font-normal normal-case tracking-normal text-muted-foreground/80">
            or type / in the composer
          </span>
        </p>
        <div className="flex gap-2 overflow-x-auto pb-1">
          {RESEARCH_SKILLS.map((s) => {
            const active = skill?.id === s.id;
            return (
              <button
                key={s.id}
                type="button"
                onClick={() => onSkill(active ? null : s)}
                className={`shrink-0 rounded-full border px-3 py-1.5 text-[12px] font-medium transition-colors ${
                  active
                    ? "border-brand-navy bg-brand-navy text-white"
                    : "border-border bg-card text-brand-navy hover:border-primary/30 hover:bg-muted/40"
                }`}
              >
                {s.label}
              </button>
            );
          })}
        </div>
        {skill ? (
          <div className="mt-3">
            <SkillForm skill={skill} onCancel={() => onSkill(null)} onRun={onSend} />
          </div>
        ) : null}
      </section>

      {headlines && headlines.length > 0 ? (
        <section>
          <p className="mb-2 px-0.5 text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
            Since you were here
          </p>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            {headlines.map((h) => (
              <article
                key={h.id}
                className="flex gap-3 rounded-lg border border-border bg-card p-2.5"
              >
                {h.imageUrl ? (
                  <img
                    src={h.imageUrl}
                    alt=""
                    loading="lazy"
                    referrerPolicy="no-referrer"
                    className="h-16 w-16 shrink-0 rounded-md object-cover bg-muted"
                    onError={(e) => {
                      (e.currentTarget as HTMLImageElement).style.display = "none";
                    }}
                  />
                ) : (
                  <span className="grid h-16 w-16 shrink-0 place-items-center rounded-md bg-muted">
                    <Favicon host={hostOf(h.url)} size={20} />
                  </span>
                )}
                <div className="min-w-0 flex-1">
                  <a
                    href={h.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="line-clamp-2 text-[12.5px] font-medium leading-snug text-brand-navy hover:underline"
                  >
                    {h.title}
                  </a>
                  <p className="mt-0.5 text-[11px] text-muted-foreground">
                    {h.source}
                    {publishedLabel(h.published) ? ` · ${publishedLabel(h.published)}` : ""}
                  </p>
                  <p className="mt-1 line-clamp-2 text-[11.5px] leading-relaxed text-muted-foreground">
                    {h.why}
                  </p>
                  <button
                    type="button"
                    onClick={() => onSend(h.prompt)}
                    className="mt-1.5 inline-flex items-center gap-1 text-[11.5px] font-medium text-brand-navy hover:underline"
                  >
                    Ask about this
                    <ArrowRight className="h-3 w-3" strokeWidth={2} />
                  </button>
                </div>
              </article>
            ))}
          </div>
        </section>
      ) : null}

      {prompts.length > 0 ? (
        <section>
          <p className="mb-2 px-0.5 text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
            Your prompts
          </p>
          <div className="flex flex-col gap-1.5">
            {prompts.map((p) => (
              <button
                key={p.itemId}
                type="button"
                onClick={() => void applyPrompt(p.itemId, p.preview || p.name)}
                className="flex items-center gap-2 rounded-lg border border-border bg-card px-3 py-2 text-left hover:border-primary/30 hover:bg-muted/40"
              >
                <Bookmark className="h-3.5 w-3.5 shrink-0 text-brand-navy/70" strokeWidth={2} />
                <span className="min-w-0 flex-1 truncate text-[12.5px] text-foreground">{p.name}</span>
              </button>
            ))}
          </div>
        </section>
      ) : null}

      {convos && convos.length > 0 ? (
        <section>
          <p className="mb-2 px-0.5 text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
            Continue
          </p>
          <div className="flex flex-col gap-1.5">
            {convos.map((c) => (
              <button
                key={c.id}
                type="button"
                onClick={() => onOpenConversation(c.id)}
                className="flex items-center gap-2 rounded-lg border border-border bg-card px-3 py-2 text-left hover:border-primary/30 hover:bg-muted/40"
              >
                <Clock3 className="h-3.5 w-3.5 shrink-0 text-brand-navy/70" strokeWidth={2} />
                <span className="min-w-0 flex-1 truncate text-[12.5px] text-foreground">
                  {c.title}
                </span>
                <span className="shrink-0 text-[11px] text-muted-foreground">
                  {relativeTime(c.updatedAt)}
                  {expiryLabel(c) ? ` · ${expiryLabel(c)}` : ""}
                </span>
              </button>
            ))}
          </div>
        </section>
      ) : null}

      <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
        <Lock className="h-3 w-3" strokeWidth={2} />
        <span>Your data is secure and confidential.</span>
        <span className="text-muted-foreground/60">·</span>
        <span>Legal research, not legal advice.</span>
      </div>
    </div>
  );
}
