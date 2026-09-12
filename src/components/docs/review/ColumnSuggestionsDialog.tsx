import { useEffect, useRef, useState } from "react";
import { Loader2, Sparkles } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { COLUMN_KINDS, type ColumnKind } from "@/lib/review/types";
import type { ColumnSuggestion, DocumentSample } from "@/lib/review/column-suggestions";

export function ColumnSuggestionsDialog({
  open,
  onOpenChange,
  remaining,
  onGenerate,
  onAdd,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  remaining: number;
  onGenerate: (
    objective: string,
    signal: AbortSignal,
  ) => Promise<{ suggestions: ColumnSuggestion[]; sample: DocumentSample }>;
  onAdd: (columns: ColumnSuggestion[]) => Promise<unknown>;
}) {
  const [objective, setObjective] = useState("");
  const [suggestions, setSuggestions] = useState<ColumnSuggestion[]>([]);
  const [sample, setSample] = useState<DocumentSample | null>(null);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [busy, setBusy] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const controller = useRef<AbortController | null>(null);
  useEffect(() => {
    if (!open) {
      controller.current?.abort();
      setBusy(false);
    }
    return () => controller.current?.abort();
  }, [open]);
  const generate = async () => {
    controller.current?.abort();
    const run = new AbortController();
    controller.current = run;
    setBusy(true);
    setError("");
    try {
      const result = await onGenerate(objective, run.signal);
      if (run.signal.aborted) return;
      setSuggestions(result.suggestions);
      setSample(result.sample);
      setSelected(new Set(result.suggestions.slice(0, remaining).map((_, i) => i)));
    } catch (e) {
      if (!run.signal.aborted)
        setError(e instanceof Error ? e.message : "Could not generate columns");
    } finally {
      if (!run.signal.aborted) setBusy(false);
    }
  };
  const update = (i: number, patch: Partial<ColumnSuggestion>) =>
    setSuggestions((s) => s.map((c, index) => (index === i ? { ...c, ...patch } : c)));
  const chosen = suggestions.filter((_, i) => selected.has(i));
  const invalid =
    chosen.some(
      (c) =>
        !c.name.trim() ||
        !c.question.trim() ||
        ((c.kind === "select" || c.kind === "multi_select") && c.options.length < 2),
    ) || new Set(chosen.map((c) => c.name.trim().toLowerCase())).size !== chosen.length;
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!saving) onOpenChange(next);
      }}
    >
      <DialogContent className="max-h-[88vh] max-w-3xl overflow-y-auto bg-white">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Sparkles className="h-4 w-4 text-brand-navy" />
            Build columns from documents
          </DialogTitle>
          <DialogDescription>
            Describe the review objective. Review and edit the proposed questions before adding them
            to your table.
          </DialogDescription>
        </DialogHeader>
        <label className="space-y-1 text-xs font-medium text-slate-700">
          <span>Review objective</span>
          <textarea
            aria-label="Review objective"
            value={objective}
            onChange={(e) => setObjective(e.target.value)}
            maxLength={8000}
            rows={3}
            className="w-full resize-y rounded-md border border-slate-300 p-3 text-sm"
            placeholder="For example: identify who knew about product risks, when they learned, and any conflicting accounts. Capture dates, responsible parties, supporting quotes, and open questions."
          />
        </label>
        <Button className="w-fit" onClick={() => void generate()} disabled={busy || saving}>
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
          {busy
            ? "Reading document samples…"
            : suggestions.length
              ? "Generate again"
              : "Suggest columns"}
        </Button>
        {error && (
          <p
            role="alert"
            className="rounded-md border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900"
          >
            {error}
          </p>
        )}
        {sample && (
          <p className="rounded-md bg-slate-50 p-2.5 text-xs text-slate-600">
            Based on representative excerpts from {sample.sampledPages} of {sample.totalPages}{" "}
            pages, covering all {sample.files} documents. Column suggestions use samples; the
            table’s full text scan reads every available text page.
          </p>
        )}
        <div className="space-y-3">
          {suggestions.map((c, i) => (
            <div
              key={i}
              className={`rounded-lg border p-3 ${selected.has(i) ? "border-slate-300 bg-white" : "border-slate-200 bg-slate-50"}`}
            >
              <div className="flex items-center gap-2">
                <input
                  type="checkbox"
                  aria-label={`Include ${c.name}`}
                  checked={selected.has(i)}
                  onChange={() =>
                    setSelected((prev) => {
                      const next = new Set(prev);
                      if (next.has(i)) next.delete(i);
                      else next.add(i);
                      return next;
                    })
                  }
                />
                <input
                  aria-label={`Column ${i + 1} name`}
                  value={c.name}
                  maxLength={100}
                  onChange={(e) => update(i, { name: e.target.value })}
                  className="min-w-0 flex-1 rounded border border-slate-200 px-2 py-1.5 text-sm font-medium"
                />
                <select
                  aria-label={`Column ${i + 1} type`}
                  value={c.kind}
                  onChange={(e) => update(i, { kind: e.target.value as ColumnKind })}
                  className="rounded border border-slate-200 px-2 py-1.5 text-xs"
                >
                  {COLUMN_KINDS.map((k) => (
                    <option key={k.value} value={k.value}>
                      {k.label}
                    </option>
                  ))}
                </select>
              </div>
              <p className="my-2 text-xs text-slate-600">{c.reason}</p>
              <textarea
                aria-label={`Column ${i + 1} question`}
                value={c.question}
                onChange={(e) => update(i, { question: e.target.value })}
                rows={3}
                maxLength={2000}
                className="w-full rounded border border-slate-200 p-2 text-xs leading-relaxed"
              />
              {(c.kind === "select" || c.kind === "multi_select") && (
                <label className="mt-2 block text-xs text-slate-600">
                  Options, separated by commas
                  <input
                    aria-label={`Column ${i + 1} options`}
                    className="mt-1 w-full rounded border p-2"
                    value={c.options.join(", ")}
                    onChange={(e) =>
                      update(i, { options: e.target.value.split(",").map((s) => s.trim()) })
                    }
                  />
                </label>
              )}
            </div>
          ))}
        </div>
        {suggestions.length > 0 && (
          <div className="flex items-center justify-between gap-3 border-t pt-3 text-xs text-slate-600">
            <span>
              {selected.size} selected · {remaining} column slots available
            </span>
            <Button
              disabled={busy || saving || !chosen.length || selected.size > remaining || invalid}
              onClick={async () => {
                setSaving(true);
                setError("");
                try {
                  await onAdd(chosen);
                  onOpenChange(false);
                  setSuggestions([]);
                  setSample(null);
                } catch (e) {
                  setError(e instanceof Error ? e.message : "Could not add columns");
                } finally {
                  setSaving(false);
                }
              }}
            >
              {saving ? "Adding…" : "Add selected columns"}
            </Button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
