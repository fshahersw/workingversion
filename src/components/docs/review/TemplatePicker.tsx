import { useState } from "react";
import { Layers, Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { COLUMN_TEMPLATES, type ColumnTemplate } from "@/lib/review/templates";
import { REVIEW_MAX_COLUMNS } from "@/lib/review/types";

export function TemplatePicker({
  open,
  existingCount,
  onOpenChange,
  onApply,
}: {
  open: boolean;
  existingCount: number;
  onOpenChange: (open: boolean) => void;
  onApply: (template: ColumnTemplate) => Promise<void>;
}) {
  const [applying, setApplying] = useState<string | null>(null);
  const [selected, setSelected] = useState<string>(COLUMN_TEMPLATES[0]?.id ?? "");
  const active = COLUMN_TEMPLATES.find((t) => t.id === selected) ?? COLUMN_TEMPLATES[0];
  const room = REVIEW_MAX_COLUMNS - existingCount;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[86vh] gap-0 overflow-hidden p-0 sm:max-w-3xl">
        <DialogHeader className="border-b px-5 py-4">
          <DialogTitle className="text-[15px]">Column templates</DialogTitle>
          <DialogDescription className="text-[12.5px]">
            One click adds a full question set. Columns you already have are kept; duplicate names
            are skipped. Room for {Math.max(0, room)} more column{room === 1 ? "" : "s"}.
          </DialogDescription>
        </DialogHeader>

        <div className="grid max-h-[60vh] grid-cols-[220px_1fr] overflow-hidden">
          <div className="overflow-y-auto border-r py-2">
            {COLUMN_TEMPLATES.map((t) => (
              <button
                key={t.id}
                type="button"
                onClick={() => setSelected(t.id)}
                className={cn(
                  "block w-full px-4 py-2 text-left transition-colors hover:bg-accent/50",
                  t.id === selected && "bg-accent",
                )}
              >
                <span className="block truncate text-[12.5px] font-medium">{t.name}</span>
                <span className="block text-[11px] text-muted-foreground">
                  {t.columns.length} columns
                </span>
              </button>
            ))}
          </div>

          <div className="flex min-h-0 flex-col">
            <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
              <p className="text-[12.5px] text-muted-foreground">{active?.blurb}</p>
              <div className="mt-3 grid gap-1.5 sm:grid-cols-2">
                {active?.columns.map((c) => (
                  <div key={c.name} className="rounded-md border bg-muted/20 px-2.5 py-1.5">
                    <p className="truncate text-[12px] font-medium">{c.name}</p>
                    <p className="truncate text-[11px] text-muted-foreground">{c.question}</p>
                  </div>
                ))}
              </div>
            </div>
            <div className="flex items-center justify-between gap-2 border-t px-5 py-3">
              <p className="text-[11.5px] text-muted-foreground">
                {active ? active.columns.length : 0} columns × your documents = one cell each.
              </p>
              <Button
                size="sm"
                className="gap-1.5 text-[12.5px]"
                disabled={!active || !!applying || room <= 0}
                onClick={async () => {
                  if (!active) return;
                  setApplying(active.id);
                  try {
                    await onApply(active);
                    onOpenChange(false);
                  } finally {
                    setApplying(null);
                  }
                }}
              >
                {applying ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <Layers className="h-3.5 w-3.5" strokeWidth={1.75} />
                )}
                Add these columns
              </Button>
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
