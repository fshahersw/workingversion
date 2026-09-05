import { useEffect, useState } from "react";
import { Loader2, Sparkles, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import type { SampleResult } from "@/lib/review/use-review-table";
import { COLUMN_KINDS, REVIEW_SAMPLE_ROWS, type ColumnKind, type ReviewColumn } from "@/lib/review/types";

export type ColumnDraft = {
  name: string;
  kind: ColumnKind;
  question: string;
  options: string[];
};

const EMPTY: ColumnDraft = { name: "", kind: "text", question: "", options: [] };

export function ColumnEditor({
  open,
  column,
  canTest,
  onOpenChange,
  onSave,
  onTest,
}: {
  open: boolean;
  column: ReviewColumn | null;
  canTest: boolean;
  onOpenChange: (open: boolean) => void;
  onSave: (draft: ColumnDraft) => Promise<void>;
  onTest: (draft: ColumnDraft) => Promise<SampleResult[]>;
}) {
  const [draft, setDraft] = useState<ColumnDraft>(EMPTY);
  const [optionText, setOptionText] = useState("");
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [samples, setSamples] = useState<SampleResult[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setDraft(
      column
        ? { name: column.name, kind: column.kind, question: column.question, options: column.options }
        : EMPTY,
    );
    setOptionText(column?.options.join(", ") ?? "");
    setSamples(null);
    setError(null);
  }, [column, open]);

  const needsOptions = draft.kind === "select" || draft.kind === "multi_select";
  const parsedOptions = optionText
    .split(",")
    .map((o) => o.trim())
    .filter(Boolean);
  const current: ColumnDraft = { ...draft, options: needsOptions ? parsedOptions : [] };
  const ready = current.name.trim().length > 0 && current.question.trim().length > 0;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[88vh] gap-0 overflow-hidden p-0 sm:max-w-2xl">
        <DialogHeader className="border-b px-5 py-4">
          <DialogTitle className="text-[15px]">
            {column ? "Edit column" : "New column"}
          </DialogTitle>
          <DialogDescription className="text-[12.5px]">
            Ask one precise question. It runs against every document on its own, and each answer
            must cite a page in that document.
          </DialogDescription>
        </DialogHeader>

        <div className="max-h-[58vh] space-y-4 overflow-y-auto px-5 py-4">
          <div className="grid gap-4 sm:grid-cols-[1fr_200px]">
            <div className="space-y-1.5">
              <Label htmlFor="col-name" className="text-[12px]">
                Column name
              </Label>
              <Input
                id="col-name"
                value={draft.name}
                placeholder="Governing law"
                onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
                className="h-9 text-[13px]"
              />
            </div>
            <div className="space-y-1.5">
              <Label className="text-[12px]">Answer type</Label>
              <Select
                value={draft.kind}
                onValueChange={(v) => setDraft((d) => ({ ...d, kind: v as ColumnKind }))}
              >
                <SelectTrigger className="h-9 text-[13px]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {COLUMN_KINDS.map((k) => (
                    <SelectItem key={k.value} value={k.value} className="text-[13px]">
                      {k.label}
                      <span className="ml-2 text-muted-foreground">{k.hint}</span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="col-question" className="text-[12px]">
              Question
            </Label>
            <Textarea
              id="col-question"
              value={draft.question}
              placeholder="What state's law governs this agreement? Answer with the state only."
              onChange={(e) => setDraft((d) => ({ ...d, question: e.target.value }))}
              className="min-h-[84px] resize-none text-[13px] leading-relaxed"
            />
            <p className="text-[11.5px] text-muted-foreground">
              If the document does not say, the cell is marked “Not found” — never guessed.
            </p>
          </div>

          {needsOptions ? (
            <div className="space-y-1.5">
              <Label htmlFor="col-options" className="text-[12px]">
                Options (comma separated)
              </Label>
              <Input
                id="col-options"
                value={optionText}
                placeholder="Privileged, Not privileged, Partially privileged"
                onChange={(e) => setOptionText(e.target.value)}
                className="h-9 text-[13px]"
              />
            </div>
          ) : null}

          {error ? (
            <p className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-[12px] text-destructive">
              {error}
            </p>
          ) : null}

          {samples ? (
            <div className="space-y-2 rounded-lg border bg-muted/25 p-3">
              <p className="text-[11.5px] font-medium uppercase tracking-wide text-muted-foreground">
                Sample results
              </p>
              {samples.map((s) => (
                <div key={s.rowId} className="rounded-md border bg-background px-3 py-2">
                  <p className="truncate text-[12px] font-medium">{s.label}</p>
                  <p className="mt-0.5 text-[12.5px] text-foreground/90">
                    {s.error
                      ? s.error
                      : s.answer?.display || (s.answer ? "Not found" : "No answer")}
                  </p>
                  {s.answer?.citations?.length ? (
                    <p className="mt-1 line-clamp-2 text-[11.5px] text-muted-foreground">
                      p.{s.answer.citations[0]?.page} — “{s.answer.citations[0]?.quote}”
                    </p>
                  ) : null}
                </div>
              ))}
            </div>
          ) : null}
        </div>

        <DialogFooter className="flex-row items-center justify-between gap-2 border-t px-5 py-3">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={!ready || testing || !canTest}
            onClick={async () => {
              setTesting(true);
              setError(null);
              try {
                setSamples(await onTest(current));
              } catch (err) {
                setError(err instanceof Error ? err.message : "Test failed");
              } finally {
                setTesting(false);
              }
            }}
            className="gap-1.5 text-[12.5px]"
          >
            {testing ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Sparkles className="h-3.5 w-3.5" strokeWidth={1.75} />
            )}
            Test on {REVIEW_SAMPLE_ROWS} documents
          </Button>

          <div className="flex items-center gap-2">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="gap-1.5 text-[12.5px]"
              onClick={() => onOpenChange(false)}
            >
              <X className="h-3.5 w-3.5" strokeWidth={1.75} />
              Cancel
            </Button>
            <Button
              type="button"
              size="sm"
              disabled={!ready || saving}
              className="text-[12.5px]"
              onClick={async () => {
                setSaving(true);
                setError(null);
                try {
                  await onSave(current);
                  onOpenChange(false);
                } catch (err) {
                  setError(err instanceof Error ? err.message : "Could not save the column");
                } finally {
                  setSaving(false);
                }
              }}
            >
              {saving ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : null}
              {column ? "Save column" : "Add column"}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
