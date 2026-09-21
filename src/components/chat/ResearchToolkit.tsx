// The Research landing toolkit: a tabbed workspace beneath the composer.
//   Research toolkit  — categorized guided tasks; a tool's prepared fields fill
//                        the composer ("Fill chat", never auto-send).
//   Recent research   — reopen a recent conversation.
//   Saved prompts     — drop a saved prompt into the composer.
// Reuses the skill engine (RESEARCH_SKILLS/composeSkill/SkillFields), the
// conversation history loader, and the saved-prompt library functions.
import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Bookmark, Clock3, Lock, MessageSquare, PenLine, Search } from "lucide-react";

import { SkillFields } from "./SkillMenu";
import { EnhancePromptPanel } from "./EnhancePromptPanel";
import {
  composeSkill,
  initialSkillValues,
  RESEARCH_SKILLS,
  SKILL_CATEGORIES,
  SKILL_CATEGORY,
  type SkillCategory,
} from "@/lib/research-skills";
import { listConversations } from "@/lib/chat/history";
import { getLibraryItemFn, listItemsFn } from "@/lib/library/library.functions";

type Tab = "toolkit" | "recent" | "saved";

const TABS: { id: Tab; label: string }[] = [
  { id: "toolkit", label: "Research toolkit" },
  { id: "recent", label: "Recent research" },
  { id: "saved", label: "Saved prompts" },
];

/**
 * Every toolkit entry: the composed guided skills plus special "meta" tools
 * (Enhance my prompt) that have their own UI rather than a prepared-fields form.
 */
type ToolItem = { id: string; label: string; hint: string; category: SkillCategory; kind: "skill" | "enhance" };

const EXTRA_TOOLS: ToolItem[] = [
  {
    id: "enhance-prompt",
    label: "Enhance my prompt",
    hint: "Rewrite a rough prompt into a structured legal request",
    category: "Practice tools",
    kind: "enhance",
  },
];

const ALL_TOOLS: ToolItem[] = [
  ...RESEARCH_SKILLS.map((s): ToolItem => ({
    id: s.id,
    label: s.label,
    hint: s.hint,
    category: SKILL_CATEGORY[s.id] ?? "Practice tools",
    kind: "skill",
  })),
  ...EXTRA_TOOLS,
];

function relative(iso: string): string {
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return "";
  const mins = Math.max(0, Math.round((Date.now() - t) / 60000));
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.round(hrs / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

export function ResearchToolkit({
  onPrefill,
  onSend,
  onOpenConversation,
}: {
  /** Fill the composer with text (tool "Fill chat" or a saved prompt). Never sends. */
  onPrefill: (text: string) => void;
  /** Fill the composer and submit (Enhance prompt "Add to chat & run"). */
  onSend: (text: string) => void;
  onOpenConversation: (id: string) => void;
}) {
  const [tab, setTab] = useState<Tab>("toolkit");

  return (
    <div className="mt-4 w-full rounded-lg border border-border bg-card shadow-sm">
      {/* Tab bar */}
      <div className="flex items-center justify-between gap-3 border-b border-border/60 px-3 py-2">
        <div className="flex items-center gap-1">
          {TABS.map((t) => {
            const on = tab === t.id;
            return (
              <button
                key={t.id}
                type="button"
                onClick={() => setTab(t.id)}
                className={`rounded-md px-2.5 py-1 text-[12.5px] font-medium transition-colors ${
                  on ? "bg-brand-blue-soft text-brand-navy" : "text-muted-foreground hover:text-brand-navy"
                }`}
              >
                {t.label}
              </button>
            );
          })}
        </div>
        {tab === "toolkit" && (
          <span className="hidden text-[11px] text-muted-foreground sm:inline">
            {ALL_TOOLS.length} guided tasks
          </span>
        )}
      </div>

      {tab === "toolkit" ? (
        <ToolkitTab onFill={onPrefill} onRun={onSend} />
      ) : tab === "recent" ? (
        <RecentTab onOpen={onOpenConversation} />
      ) : (
        <SavedPromptsTab onPrefill={onPrefill} />
      )}

      <div className="flex items-center gap-2 border-t border-border/60 px-3 py-2 text-[11px] text-muted-foreground">
        <Lock className="h-3 w-3" strokeWidth={2} />
        <span>Your data is secure and confidential.</span>
        <span className="text-muted-foreground/60">·</span>
        <span>Legal research, not legal advice.</span>
      </div>
    </div>
  );
}

function ToolkitTab({
  onFill,
  onRun,
}: {
  onFill: (text: string) => void;
  onRun: (text: string) => void;
}) {
  const [category, setCategory] = useState<SkillCategory>(SKILL_CATEGORIES[0]);
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState<string>(
    () => ALL_TOOLS.find((t) => t.category === SKILL_CATEGORIES[0])?.id ?? ALL_TOOLS[0]!.id,
  );
  const [values, setValues] = useState<Record<string, string>>(() => {
    const s = RESEARCH_SKILLS.find((x) => x.id === selectedId);
    return s ? initialSkillValues(s) : {};
  });

  const q = query.trim().toLowerCase();
  // Empty query → the active category; typing → search across all tools.
  const tools = useMemo(() => {
    if (q) return ALL_TOOLS.filter((t) => `${t.label} ${t.hint} ${t.id}`.toLowerCase().includes(q));
    return ALL_TOOLS.filter((t) => t.category === category);
  }, [q, category]);

  const chooseTool = (t: ToolItem) => {
    setSelectedId(t.id);
    const s = RESEARCH_SKILLS.find((x) => x.id === t.id);
    setValues(s ? initialSkillValues(s) : {});
  };

  // Keep the selected tool inside the visible list; if it falls out (category or
  // search change), select the first available one.
  useEffect(() => {
    if (tools.length && !tools.some((t) => t.id === selectedId)) chooseTool(tools[0]!);
  }, [tools]); // eslint-disable-line react-hooks/exhaustive-deps

  const selectedTool = ALL_TOOLS.find((t) => t.id === selectedId) ?? ALL_TOOLS[0]!;
  const skill = RESEARCH_SKILLS.find((s) => s.id === selectedId) ?? null;
  const prompt = skill ? composeSkill(skill, values) : null;

  return (
    <div>
      {/* Category tabs + search */}
      <div className="flex flex-wrap items-center gap-2 border-b border-border/60 px-3 py-2">
        <div className="flex flex-wrap items-center gap-1">
          {SKILL_CATEGORIES.map((c) => {
            const on = category === c && !q;
            return (
              <button
                key={c}
                type="button"
                onClick={() => {
                  setCategory(c);
                  setQuery("");
                }}
                className={`rounded-md px-2.5 py-1 text-[12px] font-medium transition-colors ${
                  on
                    ? "bg-brand-navy text-white"
                    : "text-muted-foreground hover:bg-muted hover:text-brand-navy"
                }`}
              >
                {c}
              </button>
            );
          })}
        </div>
        <div className="relative ml-auto w-full max-w-[220px]">
          <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Find a tool"
            aria-label="Find a tool"
            className="h-8 w-full rounded-md border border-border bg-background pl-7 pr-2 text-[12px] text-foreground outline-none placeholder:text-muted-foreground focus:border-brand-navy/40"
          />
        </div>
      </div>

      <div className="grid gap-0 sm:grid-cols-[minmax(0,1fr)_minmax(0,1.15fr)]">
        {/* Tool list */}
        <div className="max-h-[360px] overflow-y-auto border-b border-border/60 sm:border-b-0 sm:border-r">
          {tools.length === 0 ? (
            <p className="px-3 py-6 text-center text-[12px] text-muted-foreground">
              No tools match “{query.trim()}”.
            </p>
          ) : (
            tools.map((t) => {
              const on = selectedId === t.id;
              return (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => chooseTool(t)}
                  className={`flex w-full items-center gap-2 border-l-2 px-3 py-2.5 text-left transition-colors ${
                    on
                      ? "border-brand-navy bg-brand-blue-soft/50"
                      : "border-transparent hover:bg-muted/40"
                  }`}
                >
                  <span className="min-w-0 flex-1">
                    <span className="block text-[12.5px] font-medium text-brand-navy">{t.label}</span>
                    <span className="block truncate text-[11px] text-muted-foreground">{t.hint}</span>
                  </span>
                </button>
              );
            })
          )}
        </div>

        {/* Selected tool */}
        <div className="p-3">
          <div className="mb-2.5 flex items-start justify-between gap-2">
            <div className="min-w-0">
              <p className="text-[13px] font-semibold text-brand-navy">{selectedTool.label}</p>
              <p className="text-[11.5px] text-muted-foreground">{selectedTool.hint}</p>
            </div>
            <span className="shrink-0 rounded-md bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
              {selectedTool.kind === "enhance" ? "Prompt tool" : "Prepared fields"}
            </span>
          </div>

          {selectedTool.kind === "enhance" ? (
            <EnhancePromptPanel onAddToChat={onFill} onAddToChatAndRun={onRun} />
          ) : skill ? (
            <>
              <SkillFields
                skill={skill}
                values={values}
                onChange={(id, value) => setValues((v) => ({ ...v, [id]: value }))}
              />
              <div className="mt-3 flex items-center justify-between gap-2">
                <span className="text-[11px] text-muted-foreground">
                  Matter &amp; sources come from the composer.
                </span>
                <button
                  type="button"
                  disabled={!prompt}
                  onClick={() => prompt && onFill(prompt)}
                  className="inline-flex h-8 items-center gap-1.5 rounded-md bg-brand-navy px-3 text-[12px] font-medium text-white hover:bg-brand-navy/90 disabled:opacity-40"
                >
                  <PenLine className="h-3.5 w-3.5" strokeWidth={2} />
                  Fill chat
                </button>
              </div>
            </>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function RecentTab({ onOpen }: { onOpen: (id: string) => void }) {
  const { data, isLoading } = useQuery({
    queryKey: ["conversations", "recent"],
    queryFn: () => listConversations(20),
    staleTime: 30_000,
  });

  if (isLoading) {
    return <p className="px-3 py-8 text-center text-[12px] text-muted-foreground">Loading…</p>;
  }
  const rows = data ?? [];
  if (rows.length === 0) {
    return (
      <p className="px-3 py-8 text-center text-[12px] text-muted-foreground">
        No conversations yet. Ask a question to start one.
      </p>
    );
  }
  return (
    <div className="max-h-[360px] overflow-y-auto p-2">
      {rows.map((c) => (
        <button
          key={c.id}
          type="button"
          onClick={() => onOpen(c.id)}
          className="flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-left transition-colors hover:bg-muted/50"
        >
          <MessageSquare className="h-3.5 w-3.5 shrink-0 text-brand-navy/60" strokeWidth={1.9} />
          <span className="min-w-0 flex-1 truncate text-[12.5px] text-foreground">{c.title}</span>
          <span className="flex shrink-0 items-center gap-1 text-[10.5px] text-muted-foreground">
            <Clock3 className="h-3 w-3" strokeWidth={1.9} />
            {relative(c.updatedAt)}
          </span>
        </button>
      ))}
    </div>
  );
}

function SavedPromptsTab({ onPrefill }: { onPrefill: (text: string) => void }) {
  const { data, isLoading } = useQuery({
    queryKey: ["library", "prompts", "toolkit"],
    queryFn: () => listItemsFn({ data: { kind: "prompt" } }),
    staleTime: 30_000,
  });

  async function apply(itemId: string, fallback: string) {
    try {
      const full = await getLibraryItemFn({ data: { itemId } });
      onPrefill((full?.content || fallback).trim());
    } catch {
      onPrefill(fallback);
    }
  }

  if (isLoading) {
    return <p className="px-3 py-8 text-center text-[12px] text-muted-foreground">Loading…</p>;
  }
  const rows = (data ?? []) as { itemId: string; name: string; preview?: string }[];
  if (rows.length === 0) {
    return (
      <p className="px-3 py-8 text-center text-[12px] text-muted-foreground">
        No saved prompts yet. Save a prompt from the Library to reuse it here.
      </p>
    );
  }
  return (
    <div className="max-h-[360px] space-y-1 overflow-y-auto p-2">
      {rows.map((p) => (
        <button
          key={p.itemId}
          type="button"
          onClick={() => void apply(p.itemId, p.preview || p.name)}
          className="flex w-full items-center gap-2.5 rounded-md border border-border px-2.5 py-2 text-left transition-colors hover:border-primary/30 hover:bg-muted/40"
        >
          <Bookmark className="h-3.5 w-3.5 shrink-0 text-brand-navy/70" strokeWidth={2} />
          <span className="min-w-0 flex-1 truncate text-[12.5px] text-foreground">{p.name}</span>
        </button>
      ))}
    </div>
  );
}
