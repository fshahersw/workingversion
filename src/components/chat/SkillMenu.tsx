import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowRight, X } from "lucide-react";

import {
  composeSkill,
  filterSkills,
  slashDraft,
  type ResearchSkill,
} from "@/lib/research-skills";

export function SlashPalette({
  value,
  onPick,
}: {
  value: string;
  onPick: (skill: ResearchSkill) => void;
}) {
  const draft = slashDraft(value);
  // Empty unless the draft is a slash command that matches at least one skill;
  // the palette is open exactly when this is non-empty.
  const matches = useMemo(() => (draft === null ? [] : filterSkills(draft)), [draft]);
  const [active, setActive] = useState(0);

  useEffect(() => {
    setActive(0);
  }, [draft]);

  // One capture-phase listener for the palette's lifetime. It reads the current
  // matches / selection / handler through a ref instead of re-subscribing on
  // every render (onPick is usually an inline arrow), and it only claims
  // Enter/Tab while a skill is actually on offer, so a draft like "/remand"
  // that matches nothing still submits as an ordinary message.
  const latest = useRef({ matches, active, onPick });
  latest.current = { matches, active, onPick };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const cur = latest.current;
      if (!cur.matches.length) return;
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setActive((i) => (i + 1) % cur.matches.length);
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setActive((i) => (i - 1 + cur.matches.length) % cur.matches.length);
      } else if (e.key === "Tab" || e.key === "Enter") {
        const skill = cur.matches[cur.active] ?? cur.matches[0];
        if (!skill) return;
        e.preventDefault();
        cur.onPick(skill);
      }
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, []);

  if (matches.length === 0) return null;

  return (
    <div
      role="listbox"
      aria-label="Research skills"
      className="absolute inset-x-0 bottom-full z-20 mb-1 overflow-hidden rounded-lg border border-border bg-card shadow-lg"
    >
      {matches.map((skill, i) => (
        <button
          key={skill.id}
          type="button"
          role="option"
          aria-selected={i === active}
          onMouseDown={(e) => {
            e.preventDefault();
            onPick(skill);
          }}
          className={`flex w-full items-center justify-between gap-3 px-3 py-2 text-left ${
            i === active ? "bg-muted/70" : "hover:bg-muted/40"
          }`}
        >
          <span className="min-w-0">
            <span className="block text-[12.5px] font-medium text-brand-navy">
              /{skill.slash}
              <span className="ml-2 font-normal text-foreground">{skill.label}</span>
            </span>
            <span className="block text-[11px] text-muted-foreground">{skill.hint}</span>
          </span>
        </button>
      ))}
    </div>
  );
}

export function SkillForm({
  skill,
  onCancel,
  onRun,
}: {
  skill: ResearchSkill;
  onCancel: () => void;
  onRun: (prompt: string) => void;
}) {
  const [values, setValues] = useState<Record<string, string>>(() => {
    const init: Record<string, string> = {};
    for (const field of skill.fields) {
      if (field.kind === "select" && field.options?.[0]) init[field.id] = field.options[0].id;
    }
    return init;
  });

  const prompt = composeSkill(skill, values);

  return (
    <div className="rounded-lg border border-border bg-card p-3 shadow-sm">
      <div className="mb-2.5 flex items-start justify-between gap-2">
        <div>
          <p className="text-[12.5px] font-semibold text-brand-navy">{skill.label}</p>
          <p className="text-[11.5px] text-muted-foreground">{skill.hint}</p>
        </div>
        <button
          type="button"
          onClick={onCancel}
          aria-label="Close"
          className="grid h-7 w-7 place-items-center rounded-md text-muted-foreground hover:bg-muted hover:text-brand-navy"
        >
          <X className="h-3.5 w-3.5" strokeWidth={2} />
        </button>
      </div>
      <div className="grid gap-2 sm:grid-cols-2">
        {skill.fields.map((field) => (
          <label key={field.id} className="block min-w-0">
            <span className="mb-1 block text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
              {field.label}
              {field.required ? "" : " · optional"}
            </span>
            {field.kind === "select" && field.options ? (
              <select
                value={values[field.id] ?? field.options[0]?.id ?? ""}
                onChange={(e) => setValues((v) => ({ ...v, [field.id]: e.target.value }))}
                className="h-8 w-full border border-border bg-white px-2 text-[12.5px] text-foreground focus:border-primary/40 focus:outline-none"
              >
                {field.options.map((opt) => (
                  <option key={opt.id} value={opt.id}>
                    {opt.label}
                  </option>
                ))}
              </select>
            ) : (
              <input
                value={values[field.id] ?? ""}
                onChange={(e) => setValues((v) => ({ ...v, [field.id]: e.target.value }))}
                placeholder={field.placeholder}
                className="h-8 w-full border border-border bg-white px-2 text-[12.5px] text-foreground placeholder:text-muted-foreground/80 focus:border-primary/40 focus:outline-none"
              />
            )}
          </label>
        ))}
      </div>
      <div className="mt-3 flex justify-end">
        <button
          type="button"
          disabled={!prompt}
          onClick={() => prompt && onRun(prompt)}
          className="inline-flex h-8 items-center gap-1.5 rounded-md bg-brand-navy px-3 text-[12px] font-medium text-white hover:bg-brand-navy/90 disabled:opacity-40"
        >
          Run
          <ArrowRight className="h-3.5 w-3.5" strokeWidth={2} />
        </button>
      </div>
    </div>
  );
}
