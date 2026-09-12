import { useEffect, useState } from "react";
import { Bookmark, Lock } from "lucide-react";

import { SkillForm } from "./SkillMenu";
import { RESEARCH_SKILLS, type ResearchSkill } from "@/lib/research-skills";
import { listItemsFn, getLibraryItemFn } from "@/lib/library/library.functions";

export function ResearchLanding({
  onSend,
  onPrefill,
  skill,
  onSkill,
}: {
  onSend: (text: string) => void;
  onPrefill: (text: string) => void;
  skill: ResearchSkill | null;
  onSkill: (skill: ResearchSkill | null) => void;
}) {
  const [prompts, setPrompts] = useState<{ itemId: string; name: string; preview?: string }[]>([]);

  useEffect(() => {
    let cancelled = false;
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

      <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
        <Lock className="h-3 w-3" strokeWidth={2} />
        <span>Your data is secure and confidential.</span>
        <span className="text-muted-foreground/60">·</span>
        <span>Legal research, not legal advice.</span>
      </div>
    </div>
  );
}
