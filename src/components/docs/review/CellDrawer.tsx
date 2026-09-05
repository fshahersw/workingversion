import { useEffect, useMemo, useState } from "react";
import { BadgeCheck, ChevronLeft, ChevronRight, Loader2, PencilLine, RotateCw } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Textarea } from "@/components/ui/textarea";
import { listCellHistory, type CellHistoryEntry } from "@/lib/review/review-db";
import { statusLabel, type ReviewCell, type ReviewColumn, type ReviewRow } from "@/lib/review/types";

/** Highlights the cited quote inside the page so the eye lands on it. */
function HighlightedPage({ text, quote }: { text: string; quote: string }) {
  const parts = useMemo(() => {
    const needle = quote.trim();
    if (!needle || needle.length < 8) return [{ text, hit: false }];
    const idx = text.toLowerCase().indexOf(needle.toLowerCase());
    if (idx < 0) return [{ text, hit: false }];
    return [
      { text: text.slice(0, idx), hit: false },
      { text: text.slice(idx, idx + needle.length), hit: true },
      { text: text.slice(idx + needle.length), hit: false },
    ];
  }, [quote, text]);

  return (
    <p className="whitespace-pre-wrap text-[12.5px] leading-relaxed text-foreground/90">
      {parts.map((p, i) =>
        p.hit ? (
          <mark key={i} className="rounded bg-primary/20 px-0.5 text-foreground">
            {p.text}
          </mark>
        ) : (
          <span key={i}>{p.text}</span>
        ),
      )}
    </p>
  );
}

export function CellDrawer({
  open,
  cell,
  row,
  column,
  pageText,
  onOpenChange,
  onOverride,
  onVerify,
  onRerun,
}: {
  open: boolean;
  cell: ReviewCell | null;
  row: ReviewRow | null;
  column: ReviewColumn | null;
  pageText: (fileId: string, page: number) => string;
  onOpenChange: (open: boolean) => void;
  onOverride: (cell: ReviewCell, value: string) => Promise<unknown>;
  onVerify: (cell: ReviewCell, verified: boolean) => Promise<unknown>;
  onRerun: (rowId: string, columnId: string) => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState("");
  const [saving, setSaving] = useState(false);
  const [citeIndex, setCiteIndex] = useState(0);
  const [history, setHistory] = useState<CellHistoryEntry[]>([]);

  useEffect(() => {
    setEditing(false);
    setValue(cell?.display ?? "");
    setCiteIndex(0);
    if (open && cell) void listCellHistory(cell.id).then(setHistory);
    else setHistory([]);
  }, [cell, open]);

  const fileId = row?.fileIds[0] ?? "";
  const citations = cell?.citations ?? [];
  const active = citations[Math.min(citeIndex, Math.max(0, citations.length - 1))] ?? null;
  const page = active ? pageText(fileId, active.page) : "";

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="flex w-full flex-col gap-0 p-0 sm:max-w-xl">
        <SheetHeader className="border-b px-5 py-4 text-left">
          <SheetTitle className="text-[14px]">{column?.name ?? "Cell"}</SheetTitle>
          <p className="truncate text-[12px] text-muted-foreground">{row?.label}</p>
        </SheetHeader>

        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-5 py-4">
          <div className="space-y-2 rounded-lg border bg-muted/25 p-3">
            <div className="flex flex-wrap items-center gap-1.5">
              {cell ? (
                <Badge variant="secondary" className="text-[11px]">
                  {statusLabel(cell.status)}
                </Badge>
              ) : null}
              {cell?.confidence ? (
                <Badge variant="outline" className="text-[11px] capitalize">
                  {cell.confidence} confidence
                </Badge>
              ) : null}
              {cell?.overridden ? (
                <Badge variant="outline" className="text-[11px]">
                  Edited by you
                </Badge>
              ) : null}
              {cell?.verifiedAt ? (
                <Badge variant="outline" className="gap-1 text-[11px]">
                  <BadgeCheck className="h-3 w-3" strokeWidth={2} />
                  Verified
                </Badge>
              ) : null}
            </div>

            {editing ? (
              <div className="space-y-2">
                <Textarea
                  value={value}
                  onChange={(e) => setValue(e.target.value)}
                  className="min-h-[80px] resize-none text-[13px]"
                />
                <div className="flex items-center gap-2">
                  <Button
                    size="sm"
                    disabled={saving || !cell}
                    className="text-[12px]"
                    onClick={async () => {
                      if (!cell) return;
                      setSaving(true);
                      try {
                        await onOverride(cell, value);
                        setEditing(false);
                      } finally {
                        setSaving(false);
                      }
                    }}
                  >
                    {saving ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : null}
                    Save value
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="text-[12px]"
                    onClick={() => {
                      setValue(cell?.display ?? "");
                      setEditing(false);
                    }}
                  >
                    Cancel
                  </Button>
                </div>
              </div>
            ) : (
              <p className="text-[13.5px] leading-relaxed">
                {cell?.display || (
                  <span className="text-muted-foreground">
                    {cell?.error ?? "Nothing extracted yet."}
                  </span>
                )}
              </p>
            )}

            {cell?.rationale ? (
              <p className="text-[12px] leading-relaxed text-muted-foreground">{cell.rationale}</p>
            ) : null}
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              variant="outline"
              disabled={!cell}
              className="gap-1.5 text-[12px]"
              onClick={() => setEditing(true)}
            >
              <PencilLine className="h-3.5 w-3.5" strokeWidth={1.75} />
              Edit value
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={!cell}
              className="gap-1.5 text-[12px]"
              onClick={() => cell && void onVerify(cell, !cell.verifiedAt)}
            >
              <BadgeCheck className="h-3.5 w-3.5" strokeWidth={1.75} />
              {cell?.verifiedAt ? "Unverify" : "Mark verified"}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={!cell || !!cell.verifiedAt || cell.overridden}
              className="gap-1.5 text-[12px]"
              onClick={() => cell && void onRerun(cell.rowId, cell.columnId)}
            >
              <RotateCw className="h-3.5 w-3.5" strokeWidth={1.75} />
              Re-run cell
            </Button>
          </div>

          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <p className="text-[11.5px] font-medium uppercase tracking-wide text-muted-foreground">
                Source
              </p>
              {citations.length > 1 ? (
                <div className="flex items-center gap-1">
                  <Button
                    size="icon"
                    variant="ghost"
                    className="h-6 w-6"
                    onClick={() => setCiteIndex((i) => Math.max(0, i - 1))}
                  >
                    <ChevronLeft className="h-3.5 w-3.5" />
                  </Button>
                  <span className="text-[11.5px] text-muted-foreground">
                    {Math.min(citeIndex + 1, citations.length)} / {citations.length}
                  </span>
                  <Button
                    size="icon"
                    variant="ghost"
                    className="h-6 w-6"
                    onClick={() => setCiteIndex((i) => Math.min(citations.length - 1, i + 1))}
                  >
                    <ChevronRight className="h-3.5 w-3.5" />
                  </Button>
                </div>
              ) : null}
            </div>

            {active ? (
              <div className="space-y-2 rounded-lg border p-3">
                <p className="text-[11.5px] font-medium text-muted-foreground">
                  Page {active.page}
                </p>
                <p className="border-l-2 border-primary/40 pl-3 text-[12.5px] italic leading-relaxed">
                  “{active.quote}”
                </p>
                {page ? (
                  <div className="max-h-64 overflow-y-auto rounded-md bg-muted/30 p-3">
                    <HighlightedPage text={page} quote={active.quote} />
                  </div>
                ) : (
                  <p className="text-[12px] text-muted-foreground">
                    Re-upload this document in the working set to read the full page here.
                  </p>
                )}
              </div>
            ) : (
              <p className="text-[12px] text-muted-foreground">
                No citation — this cell is either not found or awaiting a run.
              </p>
            )}
          </div>

          {history.length ? (
            <div className="space-y-1.5">
              <p className="text-[11.5px] font-medium uppercase tracking-wide text-muted-foreground">
                Activity
              </p>
              {history.map((h) => (
                <p key={h.id} className="text-[11.5px] text-muted-foreground">
                  {new Date(h.createdAt).toLocaleString()} — {h.action}
                  {h.nextDisplay ? `: ${h.nextDisplay.slice(0, 80)}` : ""}
                </p>
              ))}
            </div>
          ) : null}
        </div>
      </SheetContent>
    </Sheet>
  );
}
