// Guided setup: an optional three-step path (Goal → Sources → Output) that
// composes a research request and FILLS the composer — it never sends. It reuses
// the same skill engine as the composer's `/` commands (composeSkill + the
// shared SkillFields), the matter picker, and the matter-documents query, so the
// draft it produces is identical in kind to a hand-typed request. Explicit Send
// stays the user's next action in the composer.
import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ArrowLeft, ArrowRight, Check, FileText, Loader2, PenLine, Search } from "lucide-react";

import { SkillFields } from "./SkillMenu";
import { type ComposerMode, MODE_OPTIONS, initialMode } from "./composer-kit";
import { MatterScopePicker } from "@/components/matters/MatterScopePicker";
import type { MatterScope } from "@/lib/chat-types";
import {
  composeSkill,
  filterSkills,
  initialSkillValues,
  RESEARCH_SKILLS,
  type ResearchSkill,
} from "@/lib/research-skills";
import {
  docTypeLabel,
  documentsQueryOptions,
  formatCorpusDate,
  mattersQueryOptions,
} from "@/lib/workspace";
import type { WorkspaceDocument } from "@/lib/workspace-types";

type OutputFormat = "chat" | "pdf" | "docx";
type SelectedDoc = { id: string; title: string };

const STEPS = ["Goal", "Sources", "Output"] as const;

const FORMAT_OPTIONS: { id: OutputFormat; label: string; hint: string }[] = [
  { id: "chat", label: "In chat", hint: "Answer inline in the conversation" },
  { id: "pdf", label: "PDF memo", hint: "Deliver a formatted PDF report" },
  { id: "docx", label: "Word document", hint: "Deliver an editable .docx" },
];

function deliverDirective(format: OutputFormat): string {
  return format === "pdf"
    ? " Deliver as a PDF report."
    : format === "docx"
      ? " Deliver as a Word document."
      : "";
}

export function GuidedSetup({
  matter,
  onMatterChange,
  onFill,
}: {
  matter: MatterScope | null;
  onMatterChange: (m: MatterScope | null) => void;
  /** Fill the composer with the composed request (does not send) + carry the depth. */
  onFill: (text: string, mode: ComposerMode) => void;
}) {
  const [step, setStep] = useState(0);
  const [skill, setSkill] = useState<ResearchSkill | null>(null);
  const [values, setValues] = useState<Record<string, string>>({});
  const [query, setQuery] = useState("");
  const [selectedDocs, setSelectedDocs] = useState<SelectedDoc[]>([]);
  const [focusOnly, setFocusOnly] = useState(false);
  const [format, setFormat] = useState<OutputFormat>("chat");
  const [mode, setMode] = useState<ComposerMode>(() => initialMode());

  const matches = useMemo(() => filterSkills(query), [query]);

  // Resolve the matter slug (document queries key on slug; the picker only
  // exposes matterId + label) and clear the source selection when it changes.
  const { data: matters } = useQuery(mattersQueryOptions);
  const slug = useMemo(
    () => matters?.find((m) => m.matterId === matter?.matterId)?.slug ?? null,
    [matters, matter],
  );
  useEffect(() => {
    setSelectedDocs([]);
    setFocusOnly(false);
  }, [matter?.matterId]);

  const { data: docPage, isLoading: docsLoading } = useQuery({
    ...documentsQueryOptions({ slug: slug ?? "", sort: "date-desc", limit: 40 }),
    enabled: !!slug && step === 1,
  });
  const docs: WorkspaceDocument[] = docPage?.rows ?? [];

  const chooseSkill = (s: ResearchSkill) => {
    setSkill(s);
    setValues(initialSkillValues(s));
  };
  const toggleDoc = (d: WorkspaceDocument) =>
    setSelectedDocs((prev) =>
      prev.some((x) => x.id === d.id)
        ? prev.filter((x) => x.id !== d.id)
        : [...prev, { id: d.id, title: d.title }],
    );

  const goalReady = !!skill && composeSkill(skill, values) !== null;

  const finalText = useMemo(() => {
    if (!skill) return "";
    const hasFormatField = skill.fields.some((f) => f.id === "format");
    const vals = hasFormatField ? { ...values, format } : values;
    const base = composeSkill(skill, vals);
    if (!base) return "";
    let text = base;
    if (selectedDocs.length) {
      const titles = selectedDocs.map((d) => `“${d.title}”`).join(", ");
      const where = matter?.label ?? "matter";
      text += focusOnly
        ? ` Base the analysis strictly on these documents from the ${where} file: ${titles}.`
        : ` Give particular attention to these documents from the ${where} file: ${titles}.`;
    }
    if (!hasFormatField) text += deliverDirective(format);
    return text.replace(/\s+/g, " ").trim();
  }, [skill, values, selectedDocs, focusOnly, format, matter]);

  return (
    <div className="mt-6 w-full rounded-lg border border-border bg-card shadow-sm">
      {/* step header */}
      <div className="flex items-center gap-1 border-b border-border/60 px-3 py-2.5">
        {STEPS.map((label, i) => {
          const active = i === step;
          const done = i < step;
          return (
            <button
              key={label}
              type="button"
              onClick={() => i <= step && setStep(i)}
              disabled={i > step}
              className={`inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-[12px] font-medium transition-colors ${
                active
                  ? "bg-brand-navy text-white"
                  : done
                    ? "text-brand-navy hover:bg-muted"
                    : "text-muted-foreground"
              }`}
            >
              <span
                className={`grid h-4 w-4 place-items-center rounded-full text-[9px] font-bold ${
                  active ? "bg-white/20" : done ? "bg-brand-navy/15" : "bg-muted"
                }`}
              >
                {done ? <Check className="h-2.5 w-2.5" strokeWidth={3} /> : i + 1}
              </span>
              {label}
              {i < STEPS.length - 1 && <span className="ml-1 text-muted-foreground/40">›</span>}
            </button>
          );
        })}
      </div>

      <div className="p-3">
        {/* ---- Step 1: Goal ---- */}
        {step === 0 && (
          <div>
            <p className="mb-2 text-[12.5px] font-semibold text-foreground">
              What do you need to accomplish?
            </p>
            <div className="mb-2 flex items-center gap-1.5 rounded-md border border-border bg-background px-2 py-1.5">
              <Search className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Find a task…"
                className="w-full bg-transparent text-[12.5px] placeholder:text-muted-foreground/70 focus:outline-none"
              />
            </div>
            <div className="max-h-52 space-y-1 overflow-y-auto pr-0.5">
              {matches.map((s) => {
                const on = skill?.id === s.id;
                return (
                  <button
                    key={s.id}
                    type="button"
                    onClick={() => chooseSkill(s)}
                    className={`flex w-full items-center justify-between gap-3 rounded-md border px-2.5 py-2 text-left transition-colors ${
                      on
                        ? "border-brand-navy bg-brand-blue-soft/50"
                        : "border-border hover:border-primary/30 hover:bg-muted/40"
                    }`}
                  >
                    <span className="min-w-0">
                      <span className="block text-[12.5px] font-medium text-brand-navy">
                        {s.label}
                      </span>
                      <span className="block truncate text-[11px] text-muted-foreground">
                        {s.hint}
                      </span>
                    </span>
                    {on && <Check className="h-4 w-4 shrink-0 text-brand-navy" strokeWidth={2.5} />}
                  </button>
                );
              })}
            </div>
            {skill && (
              <div className="mt-3 border-t border-border/60 pt-3">
                <SkillFields
                  skill={skill}
                  values={values}
                  onChange={(id, value) => setValues((v) => ({ ...v, [id]: value }))}
                />
              </div>
            )}
          </div>
        )}

        {/* ---- Step 2: Sources ---- */}
        {step === 1 && (
          <div>
            <p className="mb-2 text-[12.5px] font-semibold text-foreground">Scope the request</p>
            <div className="mb-3 flex flex-wrap items-center gap-2">
              <MatterScopePicker value={matter} onChange={onMatterChange} />
              <span className="text-[11.5px] text-muted-foreground">
                {matter
                  ? "Pick documents to focus on, or continue for the whole matter."
                  : "Optional — leave on all matters for broad legal research."}
              </span>
            </div>
            {matter && (
              <div>
                {docsLoading ? (
                  <p className="flex items-center gap-2 px-1 py-4 text-[12px] text-muted-foreground">
                    <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading documents…
                  </p>
                ) : docs.length === 0 ? (
                  <p className="px-1 py-4 text-[12px] text-muted-foreground">
                    No documents to list for this matter yet.
                  </p>
                ) : (
                  <>
                    <div className="max-h-52 space-y-1 overflow-y-auto pr-0.5">
                      {docs.map((d) => {
                        const on = selectedDocs.some((x) => x.id === d.id);
                        return (
                          <button
                            key={d.id}
                            type="button"
                            onClick={() => toggleDoc(d)}
                            className={`flex w-full items-center gap-2.5 rounded-md border px-2.5 py-1.5 text-left transition-colors ${
                              on
                                ? "border-brand-navy bg-brand-blue-soft/40"
                                : "border-border hover:bg-muted/40"
                            }`}
                          >
                            <span
                              className={`grid h-4 w-4 shrink-0 place-items-center rounded border ${
                                on ? "border-brand-navy bg-brand-navy text-white" : "border-border"
                              }`}
                            >
                              {on && <Check className="h-3 w-3" strokeWidth={3} />}
                            </span>
                            <FileText
                              className="h-3.5 w-3.5 shrink-0 text-brand-navy/50"
                              strokeWidth={1.8}
                            />
                            <span className="min-w-0 flex-1">
                              <span className="block truncate text-[12px] text-foreground">
                                {d.title}
                              </span>
                              <span className="block text-[10.5px] text-muted-foreground">
                                {docTypeLabel(d.docType)}
                                {d.dateFiled ? ` · ${formatCorpusDate(d.dateFiled)}` : ""}
                                {d.pageCount ? ` · ${d.pageCount} pp` : ""}
                              </span>
                            </span>
                          </button>
                        );
                      })}
                    </div>
                    {selectedDocs.length > 0 && (
                      <label className="mt-2 flex cursor-pointer items-center gap-2 text-[11.5px] text-foreground">
                        <input
                          type="checkbox"
                          checked={focusOnly}
                          onChange={(e) => setFocusOnly(e.target.checked)}
                          className="h-3.5 w-3.5 accent-brand-navy"
                        />
                        Base the analysis strictly on the {selectedDocs.length} selected document
                        {selectedDocs.length === 1 ? "" : "s"}
                      </label>
                    )}
                  </>
                )}
              </div>
            )}
          </div>
        )}

        {/* ---- Step 3: Output ---- */}
        {step === 2 && (
          <div>
            <p className="mb-2 text-[12.5px] font-semibold text-foreground">Form and depth</p>
            <div className="mb-3 grid gap-2 sm:grid-cols-2">
              <div>
                <span className="mb-1 block text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
                  Deliver as
                </span>
                <div className="space-y-1">
                  {FORMAT_OPTIONS.map((o) => (
                    <button
                      key={o.id}
                      type="button"
                      onClick={() => setFormat(o.id)}
                      className={`flex w-full items-center justify-between rounded-md border px-2.5 py-1.5 text-left text-[12px] transition-colors ${
                        format === o.id
                          ? "border-brand-navy bg-brand-blue-soft/40 text-brand-navy"
                          : "border-border text-foreground hover:bg-muted/40"
                      }`}
                    >
                      <span>
                        <span className="block font-medium">{o.label}</span>
                        <span className="block text-[10.5px] text-muted-foreground">{o.hint}</span>
                      </span>
                      {format === o.id && (
                        <Check className="h-3.5 w-3.5 shrink-0" strokeWidth={2.5} />
                      )}
                    </button>
                  ))}
                </div>
              </div>
              <div>
                <span className="mb-1 block text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
                  Depth
                </span>
                <div className="space-y-1">
                  {MODE_OPTIONS.map((o) => (
                    <button
                      key={o.id}
                      type="button"
                      onClick={() => setMode(o.id)}
                      className={`flex w-full items-center justify-between rounded-md border px-2.5 py-1.5 text-left text-[12px] transition-colors ${
                        mode === o.id
                          ? "border-brand-navy bg-brand-blue-soft/40 text-brand-navy"
                          : "border-border text-foreground hover:bg-muted/40"
                      }`}
                    >
                      <span>
                        <span className="block font-medium">{o.label}</span>
                        <span className="block text-[10.5px] text-muted-foreground">{o.hint}</span>
                      </span>
                      {mode === o.id && (
                        <Check className="h-3.5 w-3.5 shrink-0" strokeWidth={2.5} />
                      )}
                    </button>
                  ))}
                </div>
              </div>
            </div>
            <span className="mb-1 block text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
              Request preview
            </span>
            <p className="max-h-32 overflow-y-auto rounded-md border border-border bg-background px-2.5 py-2 text-[12px] leading-relaxed text-foreground/90">
              {finalText || "Complete the goal step to preview the request."}
            </p>
          </div>
        )}
      </div>

      {/* footer nav */}
      <div className="flex items-center justify-between border-t border-border/60 px-3 py-2.5">
        <button
          type="button"
          onClick={() => setStep((s) => Math.max(0, s - 1))}
          disabled={step === 0}
          className="inline-flex h-8 items-center gap-1.5 rounded-md px-2.5 text-[12px] font-medium text-muted-foreground transition-colors hover:text-brand-navy disabled:opacity-40"
        >
          <ArrowLeft className="h-3.5 w-3.5" strokeWidth={2} />
          Back
        </button>
        {step < 2 ? (
          <button
            type="button"
            onClick={() => setStep((s) => Math.min(2, s + 1))}
            disabled={step === 0 && !goalReady}
            className="inline-flex h-8 items-center gap-1.5 rounded-md bg-brand-navy px-3 text-[12px] font-medium text-white hover:bg-brand-navy/90 disabled:opacity-40"
          >
            Continue
            <ArrowRight className="h-3.5 w-3.5" strokeWidth={2} />
          </button>
        ) : (
          <button
            type="button"
            disabled={!finalText}
            onClick={() => finalText && onFill(finalText, mode)}
            className="inline-flex h-8 items-center gap-1.5 rounded-md bg-brand-navy px-3 text-[12px] font-medium text-white hover:bg-brand-navy/90 disabled:opacity-40"
          >
            <PenLine className="h-3.5 w-3.5" strokeWidth={2} />
            Fill chat
          </button>
        )}
      </div>
    </div>
  );
}
