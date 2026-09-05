import { AlertTriangle, BadgeCheck, MoreHorizontal, Plus, Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import { columnKindLabel, type ReviewCell, type ReviewColumn, type ReviewRow } from "@/lib/review/types";

export type GridDensity = "compact" | "comfortable";

/** Right-align the kinds that read as figures. */
function alignFor(column: ReviewColumn): string {
  return column.kind === "number" || column.kind === "date" ? "text-right" : "text-left";
}

function CellSkeleton({ lines }: { lines: number }) {
  return (
    <span className="flex w-full flex-col gap-1 py-0.5" aria-hidden>
      {Array.from({ length: lines }).map((_, i) => (
        <span
          key={i}
          className="h-2 rounded-full bg-muted-foreground/15 motion-safe:animate-pulse"
          style={{ width: i === lines - 1 ? "55%" : "88%" }}
        />
      ))}
    </span>
  );
}

function CellBody({
  cell,
  column,
  loading,
  clamp,
}: {
  cell: ReviewCell | null;
  column: ReviewColumn;
  loading: boolean;
  clamp: string;
}) {
  if (loading) return <CellSkeleton lines={column.kind === "long_text" ? 2 : 1} />;
  if (!cell || cell.status === "pending") {
    return <span className="text-[11.5px] text-muted-foreground/50">—</span>;
  }
  if (cell.status === "error") {
    return (
      <span className="inline-flex items-center gap-1 text-[11.5px] text-destructive">
        <AlertTriangle className="h-3 w-3" strokeWidth={2} />
        Failed
      </span>
    );
  }
  if (cell.status === "not_found") {
    return <span className="text-[11.5px] italic text-muted-foreground">Not found</span>;
  }
  if (column.kind === "yes_no") {
    const v = cell.display.trim().toLowerCase();
    const tone =
      v.startsWith("yes")
        ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400"
        : v.startsWith("no")
          ? "border-border bg-muted text-muted-foreground"
          : "border-amber-500/40 bg-amber-500/10 text-amber-700 dark:text-amber-400";
    return (
      <span className="flex items-center gap-1.5">
        <span className={cn("rounded-full border px-1.5 py-px text-[10.5px] font-medium", tone)}>
          {cell.display}
        </span>
        {cell.verifiedAt ? <BadgeCheck className="h-3 w-3 text-primary" strokeWidth={2} /> : null}
      </span>
    );
  }
  return (
    <span className="flex items-start gap-1.5">
      <span className={cn("text-[12px] leading-snug", clamp)}>{cell.display}</span>
      {cell.verifiedAt ? (
        <BadgeCheck className="mt-px h-3 w-3 shrink-0 text-primary" strokeWidth={2} />
      ) : null}
    </span>
  );
}

export function ReviewGrid({
  rows,
  columns,
  cellAt,
  linkedRowIds,
  density = "compact",
  pending,
  onOpenCell,
  onAddColumn,
  onEditColumn,
  onDeleteColumn,
  onRunColumn,
  onDeleteRow,
  onRunRow,
}: {
  rows: ReviewRow[];
  columns: ReviewColumn[];
  cellAt: (rowId: string, columnId: string) => ReviewCell | null;
  linkedRowIds: Set<string>;
  density?: GridDensity;
  pending?: Set<string>;
  onOpenCell: (rowId: string, columnId: string) => void;
  onAddColumn: () => void;
  onEditColumn: (column: ReviewColumn) => void;
  onDeleteColumn: (columnId: string) => void;
  onRunColumn: (columnId: string) => void;
  onDeleteRow: (rowId: string) => void;
  onRunRow: (rowId: string) => void;
}) {
  const compact = density === "compact";
  const cellPad = compact ? "px-2.5 py-1" : "px-3 py-2";
  const headPad = compact ? "px-2.5 py-1.5" : "px-3 py-2";
  const colWidth = compact ? "w-[200px] min-w-[200px]" : "w-[240px] min-w-[240px]";
  const docWidth = compact ? "w-[240px] min-w-[240px]" : "w-[280px] min-w-[280px]";
  const clamp = compact ? "line-clamp-2" : "line-clamp-3";
  const isPending = (rowId: string, columnId: string) => !!pending?.has(`${rowId}:${columnId}`);
  const columnBusy = (columnId: string) => rows.some((r) => isPending(r.id, columnId));

  return (
    <div className="min-h-0 flex-1 overflow-auto rounded-lg border bg-background">
      <table className="w-full border-separate border-spacing-0 text-left">
        <thead className="sticky top-0 z-20">
          <tr>
            <th
              className={cn(
                "sticky left-0 z-30 border-b border-r bg-muted/70 text-[11px] font-medium uppercase tracking-wide text-muted-foreground backdrop-blur",
                docWidth,
                headPad,
              )}
            >
              Document
            </th>
            {columns.map((col) => (
              <th
                key={col.id}
                className={cn(
                  "relative border-b border-r bg-muted/70 align-top backdrop-blur",
                  colWidth,
                  headPad,
                )}
              >
                <div className="flex items-start justify-between gap-1">
                  <button
                    type="button"
                    onClick={() => onEditColumn(col)}
                    className="min-w-0 text-left"
                  >
                    <span className="block truncate text-[12px] font-medium leading-tight text-foreground">
                      {col.name}
                    </span>
                    <span className="block truncate text-[10.5px] leading-tight text-muted-foreground">
                      {columnKindLabel(col.kind)}
                    </span>
                  </button>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button size="icon" variant="ghost" className="h-5 w-5 shrink-0">
                        <MoreHorizontal className="h-3.5 w-3.5" />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end" className="text-[12.5px]">
                      <DropdownMenuItem onClick={() => onEditColumn(col)}>
                        Edit column
                      </DropdownMenuItem>
                      <DropdownMenuItem onClick={() => onRunColumn(col.id)}>
                        Run this column
                      </DropdownMenuItem>
                      <DropdownMenuItem
                        onClick={() => onDeleteColumn(col.id)}
                        className="text-destructive focus:text-destructive"
                      >
                        Delete column
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
                {columnBusy(col.id) ? (
                  <span className="absolute inset-x-0 bottom-0 h-0.5 overflow-hidden">
                    <span className="block h-full w-1/3 bg-primary/70 motion-safe:animate-pulse" />
                  </span>
                ) : null}
              </th>
            ))}
            <th className={cn("w-[120px] min-w-[120px] border-b bg-muted/70 backdrop-blur", headPad)}>
              <Button
                size="sm"
                variant="ghost"
                onClick={onAddColumn}
                className="h-6 gap-1.5 px-2 text-[11.5px]"
              >
                <Plus className="h-3.5 w-3.5" strokeWidth={1.75} />
                Column
              </Button>
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => {
            const linked = linkedRowIds.has(row.id);
            return (
              <tr key={row.id} className={cn(i % 2 === 1 && "bg-muted/20")}>
                <td
                  className={cn(
                    "sticky left-0 z-10 border-b border-r align-top",
                    cellPad,
                    i % 2 === 1 ? "bg-muted/40" : "bg-background",
                  )}
                >
                  <div className="flex items-start justify-between gap-1">
                    <div className="min-w-0">
                      <p className="truncate text-[12px] font-medium leading-tight">{row.label}</p>
                      <p className="truncate text-[10.5px] leading-tight text-muted-foreground">
                        {row.pageCount} pages
                        {linked ? "" : " · re-upload to run"}
                      </p>
                    </div>
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button size="icon" variant="ghost" className="h-5 w-5 shrink-0">
                          <MoreHorizontal className="h-3.5 w-3.5" />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end" className="text-[12.5px]">
                        <DropdownMenuItem disabled={!linked} onClick={() => onRunRow(row.id)}>
                          Run this document
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          onClick={() => onDeleteRow(row.id)}
                          className="text-destructive focus:text-destructive"
                        >
                          <Trash2 className="mr-2 h-3.5 w-3.5" />
                          Remove document
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </div>
                </td>

                {columns.map((col) => {
                  const cell = cellAt(row.id, col.id);
                  const loading = isPending(row.id, col.id);
                  return (
                    <td key={col.id} className="border-b border-r p-0 align-top">
                      <button
                        type="button"
                        onClick={() => onOpenCell(row.id, col.id)}
                        className={cn(
                          "flex h-full w-full flex-col gap-0.5 transition-colors hover:bg-accent/50",
                          cellPad,
                          alignFor(col),
                          !loading && cell?.status === "needs_review" &&
                            "bg-amber-500/10 hover:bg-amber-500/15",
                        )}
                      >
                        <CellBody cell={cell} column={col} loading={loading} clamp={clamp} />
                        {!loading && cell?.citations?.length ? (
                          <span className="w-full truncate text-[10px] text-muted-foreground">
                            p.{cell.citations.map((c) => c.page).slice(0, 3).join(", ")}
                          </span>
                        ) : null}
                      </button>
                    </td>
                  );
                })}
                <td className="border-b" />
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
