import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AlertCircle,
  Check,
  CloudUpload,
  Download,
  FileSpreadsheet,
  Layers,
  Loader2,
  Play,
  Plus,
  Rows3,
  StopCircle,
  Table2,
  Trash2,
  Upload,
} from "lucide-react";

import { CellDrawer } from "./CellDrawer";
import { ColumnEditor, type ColumnDraft } from "./ColumnEditor";
import { ReviewGrid, type GridDensity } from "./ReviewGrid";
import { TemplatePicker } from "./TemplatePicker";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Progress } from "@/components/ui/progress";
import { useAuth } from "@/lib/use-auth";
import { takeWorkspaceHandoff } from "@/lib/kb/workspace-handoff";
import { exportCsv, exportXlsx } from "@/lib/review/export";
import { REVIEW_COLUMN_WARN, REVIEW_MAX_COLUMNS, type ReviewColumn } from "@/lib/review/types";
import { useReviewTable, type DocSaveState } from "@/lib/review/use-review-table";
import { MAX_FILES } from "@/lib/pile/limits";
import { useSharedPile } from "@/lib/pile-context";

function relativeTime(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms)) return "";
  const mins = Math.max(0, Math.round(ms / 60_000));
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.round(hrs / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/** Where this table's documents stand in the owner's account. */
function DocSaveBadge({ state, hydrating }: { state: DocSaveState; hydrating: boolean }) {
  if (hydrating) {
    return (
      <Badge variant="outline" className="gap-1 text-[11px] text-muted-foreground">
        <Loader2 className="h-3 w-3 animate-spin" />
        Loading saved documents…
      </Badge>
    );
  }
  if (state.status === "idle") return null;
  if (state.status === "saving" || state.status === "indexing") {
    return (
      <Badge variant="outline" className="gap-1 text-[11px] text-muted-foreground" title={state.message ?? undefined}>
        <CloudUpload className="h-3 w-3" />
        {state.status === "saving" ? "Saving documents…" : "Indexing documents…"}
      </Badge>
    );
  }
  if (state.status === "error") {
    return (
      <Badge
        variant="outline"
        className="gap-1 border-amber-500/40 text-[11px] text-amber-700"
        title={state.message ?? undefined}
      >
        <AlertCircle className="h-3 w-3" />
        Not all documents saved
      </Badge>
    );
  }
  return (
    <Badge variant="outline" className="gap-1 text-[11px] text-muted-foreground">
      <Check className="h-3 w-3 text-emerald-600" strokeWidth={2.5} />
      Documents saved
    </Badge>
  );
}

export function ReviewTablesTab() {
  const { user } = useAuth();
  const pile = useSharedPile();
  const sessionFiles = pile.state.session?.files;
  const shared = useMemo(
    () => ({
      getClient: pile.client,
      ingestPages: pile.ingestPages,
      liveFileIds: () => new Set((sessionFiles ?? []).map((f) => f.id)),
    }),
    [pile.client, pile.ingestPages, sessionFiles],
  );
  const review = useReviewTable(user?.sub ?? null, user?.email ?? null, shared);
  const inputRef = useRef<HTMLInputElement>(null);
  const workingFiles = sessionFiles ?? [];
  const workingSaved = pile.state.session?.savedWorkspace ?? null;

  // Library "Open" on a saved document batch lands on the table that owns it.
  const { tables: knownTables, loadTable } = review;
  const handoffRef = useRef<string | null>(null);
  useEffect(() => {
    if (handoffRef.current === null) handoffRef.current = takeWorkspaceHandoff("review") ?? "";
    const wanted = handoffRef.current;
    if (!wanted || !knownTables.length) return;
    const owner = knownTables.find((t) => t.sources.some((s) => s.workspaceItemId === wanted));
    handoffRef.current = "";
    if (owner) void loadTable(owner);
  }, [knownTables, loadTable]);

  const [editorOpen, setEditorOpen] = useState(false);
  const [editing, setEditing] = useState<ReviewColumn | null>(null);
  const [openCell, setOpenCell] = useState<{ rowId: string; columnId: string } | null>(null);
  const [newName, setNewName] = useState("");
  const [dragging, setDragging] = useState(false);
  const [templatesOpen, setTemplatesOpen] = useState(false);
  const [density, setDensity] = useState<GridDensity>("compact");

  useEffect(() => {
    const saved = window.localStorage.getItem("review.density");
    if (saved === "compact" || saved === "comfortable") setDensity(saved);
  }, []);
  const toggleDensity = useCallback(() => {
    setDensity((d) => {
      const next: GridDensity = d === "compact" ? "comfortable" : "compact";
      window.localStorage.setItem("review.density", next);
      return next;
    });
  }, []);

  const {
    table,
    tables,
    columns,
    rows,
    files,
    run,
    busy,
    error,
    stats,
    linkedRowIds,
    docSave,
    hydrating,
    cellAt,
    pageText,
    pending,
  } = review;

  const drawer = useMemo(() => {
    if (!openCell) return { cell: null, row: null, column: null };
    return {
      cell: cellAt(openCell.rowId, openCell.columnId),
      row: rows.find((r) => r.id === openCell.rowId) ?? null,
      column: columns.find((c) => c.id === openCell.columnId) ?? null,
    };
  }, [cellAt, columns, openCell, rows]);

  const onDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setDragging(false);
      const dropped = Array.from(e.dataTransfer.files ?? []);
      if (dropped.length) void review.addFiles(dropped);
    },
    [review],
  );

  const saveColumn = useCallback(
    async (draft: ColumnDraft) => {
      if (editing) await review.editColumn(editing, draft);
      else await review.addColumn(draft);
    },
    [editing, review],
  );

  // ---- table picker -----------------------------------------------------------
  if (!table) {
    const steps = [
      { n: "1", title: "Add documents", body: "Drop files or bring in a saved Working Set. Each becomes a row." },
      { n: "2", title: "Ask columns", body: "Each column is one question, typed: text, date, yes/no, options." },
      { n: "3", title: "Fill and verify", body: "Every cell is answered from its own document and cites the page." },
    ];
    const createTable = () => {
      if (!newName.trim() || busy) return;
      void review.newTable(newName);
    };
    return (
      <div className="flex h-full min-h-0 flex-col overflow-y-auto">
        <div className="flex flex-wrap items-end justify-between gap-4 border-b border-border pb-4">
          <div className="min-w-0">
            <h2 className="text-[16px] font-semibold tracking-[-0.01em] text-foreground">Tabular Review</h2>
            <p className="mt-1 max-w-xl text-[12.5px] leading-relaxed text-muted-foreground">
              A spreadsheet over a document set. Tables and their documents are saved to your
              account and reopen ready to run.
            </p>
          </div>
          <form
            className="flex w-full max-w-md items-center gap-2 sm:w-auto"
            onSubmit={(e) => {
              e.preventDefault();
              createTable();
            }}
          >
            <Input
              value={newName}
              placeholder="Name a new table"
              aria-label="New table name"
              onChange={(e) => setNewName(e.target.value)}
              className="h-9 rounded-sm text-[13px]"
            />
            <Button
              type="submit"
              size="sm"
              disabled={!newName.trim() || busy}
              className="h-9 shrink-0 gap-1.5 rounded-sm text-[12.5px]"
            >
              <Plus className="h-3.5 w-3.5" strokeWidth={1.75} />
              Create
            </Button>
          </form>
        </div>

        {error ? (
          <p className="mt-3 rounded-sm border border-destructive/30 bg-destructive/5 px-3 py-2 text-[12.5px] text-destructive">
            {error}
          </p>
        ) : null}

        <section className="mt-5">
          <div className="flex items-baseline justify-between">
            <h3 className="text-[11px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
              Saved tables
            </h3>
            {tables.length ? (
              <span className="font-mono text-[10.5px] tabular-nums text-muted-foreground">
                {tables.length}
              </span>
            ) : null}
          </div>
          {tables.length === 0 ? (
            <div className="mt-2 rounded-sm border border-dashed border-border bg-surface px-5 py-6">
              <p className="text-[12.5px] text-muted-foreground">
                No tables yet. Name one above to begin.
              </p>
            </div>
          ) : (
            <ul className="mt-2 grid gap-2 sm:grid-cols-2">
              {tables.map((t) => {
                const owned = t.sources.filter((s) => s.owned).length;
                const linked = t.sources.length - owned;
                const meta = [
                  `Updated ${relativeTime(t.updatedAt)}`,
                  owned ? `${owned} document set${owned === 1 ? "" : "s"}` : "",
                  linked ? `${linked} linked working set${linked === 1 ? "" : "s"}` : "",
                ]
                  .filter(Boolean)
                  .join(" · ");
                return (
                  <li
                    key={t.id}
                    className="group flex items-stretch rounded-sm border border-border bg-card transition-colors hover:border-brand-navy/30"
                  >
                    <button
                      type="button"
                      onClick={() => void review.loadTable(t)}
                      className="flex min-w-0 flex-1 items-center gap-3 px-3 py-3 text-left"
                    >
                      <span className="grid h-8 w-8 shrink-0 place-items-center rounded-sm bg-surface text-brand-navy">
                        <Table2 className="h-4 w-4" strokeWidth={1.75} />
                      </span>
                      <span className="min-w-0">
                        <span className="block truncate text-[13px] font-semibold text-foreground">
                          {t.name}
                        </span>
                        <span className="mt-0.5 block truncate text-[11.5px] text-muted-foreground">
                          {meta}
                        </span>
                      </span>
                    </button>
                    <button
                      type="button"
                      aria-label={`Delete ${t.name}`}
                      title="Delete table and its saved document sets"
                      onClick={() => {
                        if (window.confirm(`Delete “${t.name}”? Its saved document sets are removed too.`)) {
                          void review.removeTable(t.id);
                        }
                      }}
                      className="grid w-9 shrink-0 place-items-center rounded-r-sm text-muted-foreground/40 opacity-0 transition hover:bg-destructive/5 hover:text-destructive focus-visible:opacity-100 group-hover:opacity-100"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </section>

        <section className="mt-6 grid gap-2 sm:grid-cols-3">
          {steps.map((step) => (
            <div key={step.n} className="rounded-sm border border-border bg-surface px-3.5 py-3">
              <p className="font-mono text-[10px] text-brand-orange">{step.n}</p>
              <p className="mt-1 text-[12.5px] font-semibold text-foreground">{step.title}</p>
              <p className="mt-0.5 text-[11.5px] leading-relaxed text-muted-foreground">{step.body}</p>
            </div>
          ))}
        </section>
      </div>
    );
  }

  // ---- open table -------------------------------------------------------------
  const readyFiles = files.filter((f) => f.status === "ready").length;
  const ocrPages = files.reduce((n, f) => n + (f.ocrPages ?? 0), 0);
  const ocrBusy = files.some((f) => f.status === "ocr");
  const progressPct = run.total ? Math.round(((run.done + run.failed) / run.total) * 100) : 0;

  return (
    <div
      className="flex h-full min-h-0 flex-col gap-3"
      onDragOver={(e) => {
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={onDrop}
    >
      <div className="flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          variant="ghost"
          className="text-[12.5px] text-muted-foreground"
          onClick={() => void review.closeTable()}
        >
          Tables
        </Button>
        <Button
          size="sm"
          variant="ghost"
          className="gap-1 text-[12.5px] text-muted-foreground"
          disabled={busy || run.running}
          title="Start a blank table (this one stays saved)"
          onClick={() => void review.newTable("Untitled review")}
        >
          <Plus className="h-3.5 w-3.5" strokeWidth={1.75} />
          New
        </Button>
        <Input
          defaultValue={table.name}
          onBlur={(e) => {
            if (e.target.value.trim() && e.target.value !== table.name)
              void review.rename(e.target.value);
          }}
          className="h-8 w-[260px] border-transparent bg-transparent px-2 text-[13.5px] font-medium hover:border-input focus-visible:border-input"
        />
        <Badge variant="secondary" className="text-[11px]">
          {rows.length} docs · {columns.length}/{REVIEW_MAX_COLUMNS} columns
        </Badge>
        {stats.needsReview ? (
          <Badge variant="outline" className="border-amber-500/40 text-[11px] text-amber-600">
            {stats.needsReview} need review
          </Badge>
        ) : null}
        {stats.errors ? (
          <Badge variant="outline" className="border-destructive/40 text-[11px] text-destructive">
            {stats.errors} failed
          </Badge>
        ) : null}
        {ocrBusy ? (
          <Badge variant="outline" className="text-[11px] text-muted-foreground">
            Reading scanned pages…
          </Badge>
        ) : ocrPages ? (
          <Badge variant="outline" className="text-[11px] text-muted-foreground">
            {ocrPages} page{ocrPages === 1 ? "" : "s"} recovered by vision OCR
          </Badge>
        ) : null}
        <DocSaveBadge state={docSave} hydrating={hydrating} />

        <div className="ml-auto flex items-center gap-1.5">
          <input
            ref={inputRef}
            type="file"
            multiple
            hidden
            accept=".pdf,.docx,.txt,.xlsx,.pptx"
            onChange={(e) => {
              const picked = Array.from(e.target.files ?? []);
              if (picked.length) void review.addFiles(picked);
              e.target.value = "";
            }}
          />
          <Button
            size="sm"
            variant="outline"
            className="gap-1.5 text-[12.5px]"
            disabled={busy}
            onClick={() => inputRef.current?.click()}
          >
            <Upload className="h-3.5 w-3.5" strokeWidth={1.75} />
            Add documents
          </Button>
          <Button
            size="sm"
            variant="outline"
            className="gap-1.5 text-[12.5px]"
            disabled={busy || !workingFiles.length}
            title={
              workingSaved
                ? "Add the saved Working Set's documents as rows"
                : "Add the open Working Set's documents as rows (save it to keep them with this table)"
            }
            onClick={() => void review.useWorkingSet(workingFiles, workingSaved)}
          >
            <Table2 className="h-3.5 w-3.5" strokeWidth={1.75} />
            Use working set
          </Button>
          <Button
            size="sm"
            variant="outline"
            className="gap-1.5 text-[12.5px]"
            disabled={columns.length >= REVIEW_MAX_COLUMNS}
            onClick={() => setTemplatesOpen(true)}
          >
            <Layers className="h-3.5 w-3.5" strokeWidth={1.75} />
            Templates
          </Button>
          <Button
            size="sm"
            variant="outline"
            className="gap-1.5 text-[12.5px]"
            disabled={columns.length >= REVIEW_MAX_COLUMNS}
            onClick={() => {
              setEditing(null);
              setEditorOpen(true);
            }}
          >
            <Plus className="h-3.5 w-3.5" strokeWidth={1.75} />
            Column
          </Button>
          <Button
            size="icon"
            variant="ghost"
            title={density === "compact" ? "Comfortable rows" : "Compact rows"}
            className="h-8 w-8 text-muted-foreground"
            onClick={toggleDensity}
          >
            <Rows3 className="h-3.5 w-3.5" strokeWidth={1.75} />
          </Button>
          {run.running ? (
            <Button size="sm" variant="destructive" className="gap-1.5 text-[12.5px]" onClick={review.cancel}>
              <StopCircle className="h-3.5 w-3.5" strokeWidth={1.75} />
              Stop
            </Button>
          ) : (
            <Button
              size="sm"
              className="gap-1.5 text-[12.5px]"
              disabled={!rows.length || !columns.length}
              onClick={() => void review.runCells()}
            >
              <Play className="h-3.5 w-3.5" strokeWidth={1.75} />
              Fill table
            </Button>
          )}
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button size="sm" variant="ghost" className="gap-1.5 text-[12.5px]">
                <Download className="h-3.5 w-3.5" strokeWidth={1.75} />
                Export
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="text-[12.5px]">
              <DropdownMenuItem onClick={() => exportCsv(table, rows, columns, cellAt)}>
                CSV with citations
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => void exportXlsx(table, rows, columns, cellAt)}>
                <FileSpreadsheet className="mr-2 h-3.5 w-3.5" />
                Excel + citations sheet
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      {run.running || run.label ? (
        <div className="flex items-center gap-3 rounded-md border bg-muted/25 px-3 py-2">
          {run.running ? <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" /> : null}
          <span className="text-[12px] text-muted-foreground">
            {run.label}
            {run.total ? ` · ${run.done + run.failed}/${run.total} cells` : ""}
            {run.skipped ? ` · ${run.skipped} kept` : ""}
            {run.running && pending.size ? ` · ${pending.size} in flight` : ""}
          </span>
          {run.running ? <Progress value={progressPct} className="h-1.5 max-w-[240px] flex-1" /> : null}
        </div>
      ) : null}

      {error ? (
        <p className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-[12.5px] text-destructive">
          {error}
        </p>
      ) : null}
      {docSave.status === "error" && docSave.message ? (
        <p className="rounded-md border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-[12.5px] text-amber-800">
          {docSave.message}
        </p>
      ) : null}

      {rows.length === 0 ? (
        <div
          className={`flex min-h-0 flex-1 flex-col items-center justify-center gap-2 rounded-lg border border-dashed ${
            dragging ? "border-primary bg-primary/5" : ""
          }`}
        >
          <Table2 className="h-6 w-6 text-muted-foreground" strokeWidth={1.5} />
          <p className="text-[13px] font-medium">Drop documents to build the table</p>
          <p className="max-w-md text-center text-[12px] text-muted-foreground">
            PDF, Word, Excel, PowerPoint or text — up to {MAX_FILES} documents. Each becomes one
            row; add columns for the questions you want answered about every document.
          </p>
          <div className="mt-1 flex items-center gap-2">
            <Button size="sm" variant="outline" className="text-[12.5px]" onClick={() => inputRef.current?.click()}>
              Choose files
            </Button>
            {workingFiles.length ? (
              <Button
                size="sm"
                variant="outline"
                className="text-[12.5px]"
                disabled={busy}
                onClick={() => void review.useWorkingSet(workingFiles, workingSaved)}
              >
                Use working set ({workingFiles.length})
              </Button>
            ) : null}
          </div>
        </div>
      ) : (
        <ReviewGrid
          rows={rows}
          columns={columns}
          cellAt={cellAt}
          linkedRowIds={linkedRowIds}
          density={density}
          pending={pending}
          onOpenCell={(rowId, columnId) => setOpenCell({ rowId, columnId })}
          onAddColumn={() => {
            setEditing(null);
            setEditorOpen(true);
          }}
          onEditColumn={(col) => {
            setEditing(col);
            setEditorOpen(true);
          }}
          onDeleteColumn={(id) => void review.removeColumn(id)}
          onRunColumn={(id) => void review.runCells({ columnIds: [id] })}
          onDeleteRow={(id) => void review.removeRow(id)}
          onRunRow={(id) => void review.runCells({ rowIds: [id] })}
        />
      )}

      {readyFiles && rows.length ? (
        <p className="text-[11.5px] text-muted-foreground">
          {readyFiles} document{readyFiles === 1 ? "" : "s"} loaded in this session ·{" "}
          {stats.pages.toLocaleString()} pages · {stats.filled}/{stats.total || 0} cells filled
        </p>
      ) : null}

      {columns.length > REVIEW_COLUMN_WARN ? (
        <p className="text-[11.5px] text-muted-foreground">
          {columns.length} columns × {rows.length} documents ={" "}
          {(columns.length * rows.length).toLocaleString()} cells — a full fill will take a while.
          Run one column at a time from its menu if you want to stage it.
        </p>
      ) : null}

      <TemplatePicker
        open={templatesOpen}
        existingCount={columns.length}
        onOpenChange={setTemplatesOpen}
        onApply={async (template) => {
          await review.addColumns(template.columns);
        }}
      />

      <ColumnEditor
        open={editorOpen}
        column={editing}
        canTest={linkedRowIds.size > 0}
        onOpenChange={setEditorOpen}
        onSave={saveColumn}
        onTest={review.testColumn}
      />

      <CellDrawer
        open={!!openCell}
        cell={drawer.cell}
        row={drawer.row}
        column={drawer.column}
        pageText={pageText}
        onOpenChange={(open) => !open && setOpenCell(null)}
        onOverride={review.override}
        onVerify={review.setVerified}
        onRerun={async (rowId, columnId) => {
          await review.runCells({ rowIds: [rowId], columnIds: [columnId], force: true });
        }}
      />
    </div>
  );
}
