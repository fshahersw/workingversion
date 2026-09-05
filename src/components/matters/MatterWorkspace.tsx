import { memo, useCallback, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { AnimatePresence, motion } from "framer-motion";
import {
  ArrowDownUp,
  Building2,
  ChevronLeft,
  ChevronRight,
  FileText,
  Filter,
  Gavel,
  Loader2,
  PanelRightClose,
  PanelRightOpen,
  Search,
  Users,
  X,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Toggle } from "@/components/ui/toggle";
import { PdfViewer } from "@/components/matters/PdfViewer";
import {
  docTypeLabel,
  documentsQueryOptions,
  entriesQueryOptions,
  entryDocumentsQueryOptions,
  formatBytes,
  formatCorpusDate,
  workspaceQueryOptions,
} from "@/lib/workspace";
import type { MatterWorkspace as Workspace, WorkspaceDocument, WorkspaceEntry } from "@/lib/workspace-types";

const PAGE_SIZE = 50;

type SearchState = {
  tab: "ledger" | "documents";
  q?: string;
  types?: string[];
  withPdf?: boolean;
  docket?: "main" | "jpml";
  sort?: "entry-desc" | "entry-asc";
  entry?: string;
  page?: number;
};

/** Entry numbers repeat across docket sources, so the expanded row is keyed by both. */
const entryKey = (e: WorkspaceEntry) => `${e.docketSource}:${e.entryNumber}`;

type Props = {
  slug: string;
  search: SearchState;
  onSearch: (patch: Partial<SearchState>) => void;
};

export function MatterWorkspace({ slug, search, onSearch }: Props) {
  const { data: ws } = useQuery(workspaceQueryOptions(slug));
  const [railOpen, setRailOpen] = useState(true);

  if (!ws) {
    return (
      <div className="flex h-full items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-brand-blue" />
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <WorkspaceHeader ws={ws} railOpen={railOpen} onToggleRail={() => setRailOpen((v) => !v)} />
      <div className="flex min-h-0 flex-1">
        <div className="flex min-w-0 flex-1 flex-col">
          <WorkspaceToolbar ws={ws} search={search} onSearch={onSearch} />
          <div className="min-h-0 flex-1">
            {search.tab === "ledger" ? (
              <LedgerTable slug={slug} ws={ws} search={search} onSearch={onSearch} />
            ) : (
              <DocumentsTable slug={slug} search={search} onSearch={onSearch} />
            )}
          </div>
        </div>
        <AnimatePresence initial={false}>
          {railOpen && (
            <motion.aside
              initial={{ width: 0, opacity: 0 }}
              animate={{ width: 272, opacity: 1 }}
              exit={{ width: 0, opacity: 0 }}
              transition={{ duration: 0.25, ease: [0.32, 0.72, 0, 1] }}
              className="hidden shrink-0 overflow-hidden border-l bg-card lg:block"
            >
              <RightRail ws={ws} />
            </motion.aside>
          )}
        </AnimatePresence>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------

function WorkspaceHeader({
  ws,
  railOpen,
  onToggleRail,
}: {
  ws: Workspace;
  railOpen: boolean;
  onToggleRail: () => void;
}) {
  const m = ws.matter;
  return (
    <div className="shrink-0 border-b bg-card px-4 py-3 md:px-6">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-lg font-bold tracking-tight text-foreground">{m.shortName}</h1>
            {m.stage && (
              <Badge variant="secondary" className="text-[10px] uppercase tracking-wide">
                {m.stage}
              </Badge>
            )}
            {m.status && (
              <Badge variant="outline" className="text-[10px] uppercase tracking-wide">
                {m.status}
              </Badge>
            )}
          </div>
          <p className="mt-0.5 truncate text-sm text-muted-foreground">{m.caseName}</p>
          <div className="mt-1.5 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
            <span className="flex items-center gap-1">
              <Gavel className="h-3 w-3" /> {m.docketNumber}
              {m.mdlNumber ? ` · MDL No. ${m.mdlNumber}` : ""}
            </span>
            <span className="flex items-center gap-1">
              <Building2 className="h-3 w-3" /> {m.courtName ?? m.courtId}
            </span>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <Button variant="ghost" size="icon" className="hidden lg:inline-flex" onClick={onToggleRail}>
            {railOpen ? <PanelRightClose className="h-4 w-4" /> : <PanelRightOpen className="h-4 w-4" />}
          </Button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------

function WorkspaceToolbar({ ws, search, onSearch }: { ws: Workspace; search: SearchState; onSearch: Props["onSearch"] }) {
  const [input, setInput] = useState(search.q ?? "");
  const submitSearch = useCallback(
    (value: string) => onSearch({ q: value.trim() || undefined, page: 0 }),
    [onSearch],
  );

  const toggleType = (t: string) => {
    const cur = new Set(search.types ?? []);
    if (cur.has(t)) cur.delete(t);
    else cur.add(t);
    onSearch({ types: cur.size ? [...cur] : undefined, page: 0 });
  };

  return (
    <div className="shrink-0 space-y-2 border-b bg-card px-4 py-2.5 md:px-6">
      <div className="flex items-center gap-2">
        <Tabs value={search.tab} onValueChange={(v) => onSearch({ tab: v as SearchState["tab"], page: 0, entry: undefined })}>
          <TabsList className="h-8">
            <TabsTrigger value="ledger" className="h-6 px-3 text-xs">
              Docket Ledger
              <span className="ml-1.5 rounded bg-muted px-1 text-[10px] text-muted-foreground">
                {ws.matter.entries.toLocaleString()}
              </span>
            </TabsTrigger>
            <TabsTrigger value="documents" className="h-6 px-3 text-xs">
              Documents
              <span className="ml-1.5 rounded bg-muted px-1 text-[10px] text-muted-foreground">
                {ws.matter.documents.toLocaleString()}
              </span>
            </TabsTrigger>
          </TabsList>
        </Tabs>
        <div className="relative min-w-0 flex-1">
          <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && submitSearch(input)}
            onBlur={() => submitSearch(input)}
            placeholder={search.tab === "ledger" ? "Search docket text… (Enter)" : "Search document titles… (Enter)"}
            className="h-8 pl-8 text-xs"
          />
          {input && (
            <button
              className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
              onClick={() => {
                setInput("");
                submitSearch("");
              }}
            >
              <X className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
        <div className="hidden shrink-0 items-center rounded-md border bg-muted/40 p-0.5 sm:flex">
          {([
            ["", "All"],
            ["main", "Main docket"],
            ["jpml", "JPML"],
          ] as const).map(([value, label]) => {
            const active = (search.docket ?? "") === value;
            return (
              <button
                key={label}
                type="button"
                onClick={() => onSearch({ docket: value || undefined, page: 0, entry: undefined })}
                className={`rounded px-2 py-1 text-[11px] font-medium transition-colors ${
                  active ? "bg-card text-brand-navy shadow-sm" : "text-muted-foreground hover:text-foreground"
                }`}
              >
                {label}
              </button>
            );
          })}
        </div>
        <Toggle

          size="sm"
          pressed={!!search.withPdf}
          onPressedChange={(v) => onSearch({ withPdf: v || undefined, page: 0 })}
          className="h-8 gap-1 px-2.5 text-xs data-[state=on]:bg-brand-blue-soft data-[state=on]:text-brand-navy"
        >
          <FileText className="h-3.5 w-3.5" /> PDF
        </Toggle>
        <Toggle
          size="sm"
          pressed={search.sort === "entry-asc"}
          onPressedChange={(v) => onSearch({ sort: v ? "entry-asc" : undefined, page: 0 })}
          className="h-8 gap-1 px-2.5 text-xs"
          title="Toggle oldest/newest first"
        >
          <ArrowDownUp className="h-3.5 w-3.5" />
          {search.sort === "entry-asc" ? "Oldest" : "Newest"}
        </Toggle>
        {ws.typeFacets.length > 0 && (
          <Popover>
            <PopoverTrigger asChild>
              <Button
                variant="outline"
                size="sm"
                className={`h-8 shrink-0 gap-1.5 px-2.5 text-xs ${
                  search.types?.length ? "border-brand-navy/40 bg-brand-blue-soft text-brand-navy" : ""
                }`}
              >
                <Filter className="h-3.5 w-3.5" />
                Type
                {search.types?.length ? (
                  <span className="rounded bg-brand-navy px-1 text-[10px] font-semibold text-white">
                    {search.types.length}
                  </span>
                ) : null}
              </Button>
            </PopoverTrigger>
            <PopoverContent align="end" className="w-56 p-1.5">
              <p className="px-2 pb-1.5 pt-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                Filing type
              </p>
              <div className="max-h-64 overflow-y-auto">
                {ws.typeFacets.map((f) => {
                  const active = !!search.types?.includes(f.type);
                  return (
                    <label
                      key={f.type}
                      className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-xs capitalize transition-colors hover:bg-muted"
                    >
                      <Checkbox checked={active} onCheckedChange={() => toggleType(f.type)} className="h-3.5 w-3.5" />
                      <span className="min-w-0 flex-1 truncate">{docTypeLabel(f.type)}</span>
                      <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground">{f.count}</span>
                    </label>
                  );
                })}
              </div>
              {search.types?.length ? (
                <button
                  type="button"
                  onClick={() => onSearch({ types: undefined, page: 0 })}
                  className="mt-1 w-full rounded-md px-2 py-1.5 text-left text-[11px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
                >
                  Clear type filters
                </button>
              ) : null}
            </PopoverContent>
          </Popover>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------

function LedgerTable({ slug, ws, search, onSearch }: { slug: string; ws: Workspace; search: SearchState; onSearch: Props["onSearch"] }) {
  const q = useMemo(
    () => ({
      slug,
      search: search.q,
      types: search.types,
      onlyWithPdf: search.withPdf,
      docket: search.docket,
      sort: search.sort ?? "entry-desc",
      offset: (search.page ?? 0) * PAGE_SIZE,
      limit: PAGE_SIZE,
    }),
    [slug, search],
  );
  const { data, isFetching, isLoading } = useQuery({ ...entriesQueryOptions(q), placeholderData: (p) => p });
  const rows = data?.rows ?? [];
  const total = data?.total ?? 0;
  const page = search.page ?? 0;
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <div className="flex h-full flex-col">
      <div className={`h-0.5 shrink-0 bg-brand-blue/50 transition-opacity duration-300 ${isFetching && !isLoading ? "animate-pulse opacity-100" : "opacity-0"}`} />
      <ScrollArea className="min-h-0 flex-1">
        <table className="w-full text-sm">
          <thead className="sticky top-0 z-10 bg-muted/80 text-left text-[11px] uppercase tracking-wide text-muted-foreground backdrop-blur">
            <tr>
              <th className="w-14 px-3 py-2 font-medium">#</th>
              <th className="w-28 px-3 py-2 font-medium">Filed</th>
              <th className="px-3 py-2 font-medium">Description</th>
              <th className="hidden w-32 px-3 py-2 font-medium md:table-cell">Type</th>
              <th className="w-16 px-3 py-2 text-right font-medium">Pages</th>
              <th className="w-14 px-3 py-2 text-right font-medium">Docs</th>
            </tr>
          </thead>
          <tbody>
            {isLoading && <TableSkeleton cols={6} />}
            {rows.length === 0 && !isFetching && (
              <tr>
                <td colSpan={6} className="px-4 py-16 text-center">
                  <FileText className="mx-auto mb-3 h-8 w-8 text-muted-foreground/40" />
                  <p className="text-sm font-medium text-foreground">No docket entries yet</p>
                  <p className="mx-auto mt-1 max-w-sm text-xs text-muted-foreground">
                    {ws.matter.documents === 0
                      ? "Docket entries will appear here once the ingest pipeline processes this matter's filings."
                      : "No entries match the current filters."}
                  </p>
                </td>
              </tr>
            )}
            {rows.map((e, i) => (
              <LedgerRow
                key={e.id}
                slug={slug}
                entry={e}
                zebra={i % 2 === 1}
                expanded={search.entry === entryKey(e)}
                onToggle={() => onSearch({ entry: search.entry === entryKey(e) ? undefined : entryKey(e) })}
              />
            ))}
          </tbody>
        </table>
      </ScrollArea>
      {total > 0 && (
        <Pager
          page={page}
          pages={pages}
          total={total}
          label="entries"
          onPage={(p) => onSearch({ page: p })}
        />
      )}
    </div>
  );
}

const LedgerRow = memo(function LedgerRow({
  slug,
  entry,
  expanded,
  zebra,
  onToggle,
}: {
  slug: string;
  entry: WorkspaceEntry;
  expanded: boolean;
  zebra: boolean;
  onToggle: () => void;
}) {
  return (
    <>
      <tr
        onClick={onToggle}
        className={`cursor-pointer border-b text-[13px] transition-colors ${
          expanded ? "bg-brand-blue-soft/60" : `${zebra ? "bg-muted/25" : ""} hover:bg-muted/50`
        }`}
      >
        <td className="px-3 py-2.5 font-mono text-xs font-semibold text-brand-navy">{entry.entryLabel}</td>
        <td className="whitespace-nowrap px-3 py-2.5 text-xs text-muted-foreground">{formatCorpusDate(entry.dateFiled)}</td>
        <td className="max-w-0 px-3 py-2.5">
          <span className={`block text-foreground ${expanded ? "" : "truncate"}`}>{entry.description}</span>
        </td>
        <td className="hidden px-3 py-2.5 md:table-cell">
          {entry.entryType && (
            <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] capitalize text-muted-foreground">
              {docTypeLabel(entry.entryType)}
            </span>
          )}
        </td>
        <td className="px-3 py-2.5 text-right text-xs tabular-nums text-muted-foreground">{entry.pageCount ?? "—"}</td>
        <td className="px-3 py-2.5 text-right">
          {entry.documentCount > 0 && (
            <span
              className={`inline-flex items-center gap-0.5 text-xs ${entry.hasPdf ? "text-brand-blue" : "text-muted-foreground/50"}`}
            >
              <FileText className="h-3 w-3" />
              {entry.documentCount}
            </span>
          )}
        </td>
      </tr>
      {expanded && (
        <tr>
          <td colSpan={6} className="border-b bg-muted/20 p-0">
            <motion.div
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: "auto", opacity: 1 }}
              transition={{ duration: 0.25, ease: [0.32, 0.72, 0, 1] }}
              className="overflow-hidden"
            >
              <EntryViewer slug={slug} entryId={entry.id} />
            </motion.div>
          </td>
        </tr>
      )}
    </>
  );
});

function EntryViewer({ slug, entryId }: { slug: string; entryId: string }) {
  const { data: docs, isLoading } = useQuery(entryDocumentsQueryOptions(slug, entryId));
  const [docId, setDocId] = useState<string | null>(null);
  const selected = docId ?? docs?.find((d) => d.hasPdf)?.id ?? null;

  return (
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      className="flex flex-col gap-3 p-3 md:flex-row"
    >
      <div className="w-full shrink-0 md:w-72">
        <p className="mb-1.5 px-1 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
          Documents on this entry
        </p>
        {isLoading ? (
          <div className="flex items-center gap-2 px-1 py-2 text-xs text-muted-foreground">
            <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading…
          </div>
        ) : docs && docs.length > 0 ? (
          <ul className="space-y-1">
            {docs.map((d) => (
              <li key={d.id}>
                <button
                  onClick={() => d.hasPdf && setDocId(d.id)}
                  disabled={!d.hasPdf}
                  className={`flex w-full items-center gap-2 rounded-md border px-2.5 py-1.5 text-left text-xs transition-colors ${
                    selected === d.id
                      ? "border-brand-navy bg-brand-blue-soft text-brand-navy"
                      : d.hasPdf
                        ? "border-border bg-card text-foreground hover:border-brand-blue/50"
                        : "cursor-not-allowed border-border/50 bg-muted/30 text-muted-foreground/60"
                  }`}
                >
                  <FileText className="h-3.5 w-3.5 shrink-0" />
                  <span className="min-w-0 flex-1 truncate">
                    {d.attachmentNumber > 0 ? `Attachment ${d.attachmentNumber} — ` : ""}
                    {d.title || "Main document"}
                  </span>
                  {d.pageCount != null && <span className="shrink-0 text-[10px] text-muted-foreground">{d.pageCount}p</span>}
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="px-1 py-2 text-xs text-muted-foreground">No documents recorded for this entry.</p>
        )}
      </div>
      <div className="min-w-0 flex-1">
        {selected ? (
          <PdfViewer key={selected} documentId={selected} />
        ) : (
          <div className="flex h-full min-h-64 items-center justify-center rounded-lg border border-dashed text-xs text-muted-foreground">
            Select a document to preview the PDF
          </div>
        )}
      </div>
    </motion.div>
  );
}

// ---------------------------------------------------------------------------

function DocumentsTable({ slug, search, onSearch }: { slug: string; search: SearchState; onSearch: Props["onSearch"] }) {
  const q = useMemo(
    () => ({
      slug,
      search: search.q,
      types: search.types,
      onlyWithPdf: search.withPdf,
      docket: search.docket,
      sort: search.sort ?? "entry-desc",
      offset: (search.page ?? 0) * PAGE_SIZE,
      limit: PAGE_SIZE,
    }),
    [slug, search],
  );
  const { data, isFetching, isLoading } = useQuery({ ...documentsQueryOptions(q), placeholderData: (p) => p });
  const rows = data?.rows ?? [];
  const total = data?.total ?? 0;
  const page = search.page ?? 0;
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const [docId, setDocId] = useState<string | null>(null);

  return (
    <div className="flex h-full flex-col">
      <div className={`h-0.5 shrink-0 bg-brand-blue/50 transition-opacity duration-300 ${isFetching && !isLoading ? "animate-pulse opacity-100" : "opacity-0"}`} />
      <ScrollArea className="min-h-0 flex-1">
        <table className="w-full text-sm">
          <thead className="sticky top-0 z-10 bg-muted/80 text-left text-[11px] uppercase tracking-wide text-muted-foreground backdrop-blur">
            <tr>
              <th className="w-20 px-3 py-2 font-medium">Entry</th>
              <th className="w-12 px-3 py-2 font-medium">Att.</th>
              <th className="px-3 py-2 font-medium">Title</th>
              <th className="hidden w-32 px-3 py-2 font-medium md:table-cell">Type</th>
              <th className="hidden w-16 px-3 py-2 text-right font-medium sm:table-cell">Pages</th>
              <th className="w-20 px-3 py-2 text-right font-medium">Size</th>
              <th className="hidden w-24 px-3 py-2 text-right font-medium lg:table-cell">Text</th>
            </tr>
          </thead>
          <tbody>
            {isLoading && <TableSkeleton cols={7} />}
            {rows.length === 0 && !isFetching && (
              <tr>
                <td colSpan={7} className="px-4 py-16 text-center">
                  <FileText className="mx-auto mb-3 h-8 w-8 text-muted-foreground/40" />
                  <p className="text-sm font-medium text-foreground">No documents yet</p>
                  <p className="mx-auto mt-1 max-w-sm text-xs text-muted-foreground">
                    Documents will appear here once the ingest pipeline processes this matter's filings.
                  </p>
                </td>
              </tr>
            )}
            {rows.map((d, i) => (
              <DocRow
                key={d.id}
                doc={d}
                zebra={i % 2 === 1}
                expanded={docId === d.id}
                onToggle={() => setDocId(docId === d.id ? null : d.id)}
              />
            ))}
          </tbody>
        </table>
      </ScrollArea>
      {total > 0 && (
        <Pager page={page} pages={pages} total={total} label="documents" onPage={(p) => onSearch({ page: p })} />
      )}
    </div>
  );
}

const DocRow = memo(function DocRow({
  doc,
  expanded,
  zebra,
  onToggle,
}: {
  doc: WorkspaceDocument;
  expanded: boolean;
  zebra: boolean;
  onToggle: () => void;
}) {
  return (
    <>
      <tr
        onClick={() => doc.hasPdf && onToggle()}
        className={`border-b text-[13px] transition-colors ${
          doc.hasPdf ? "cursor-pointer" : "cursor-default"
        } ${expanded ? "bg-brand-blue-soft/60" : `${zebra ? "bg-muted/25" : ""} ${doc.hasPdf ? "hover:bg-muted/50" : ""}`}`}
      >
        <td className="px-3 py-2.5 font-mono text-xs font-semibold text-brand-navy">{doc.entryLabel || "—"}</td>
        <td className="px-3 py-2.5 text-xs text-muted-foreground">{doc.attachmentNumber || ""}</td>
        <td className="max-w-0 px-3 py-2.5">
          <span className="flex items-center gap-1.5">
            {doc.hasPdf ? (
              <FileText className="h-3.5 w-3.5 shrink-0 text-brand-blue" />
            ) : (
              <FileText className="h-3.5 w-3.5 shrink-0 text-muted-foreground/40" />
            )}
            <span className={`block truncate ${doc.hasPdf ? "text-foreground" : "text-muted-foreground/70"}`}>
              {doc.title}
            </span>
            {doc.isSealed && (
              <span className="shrink-0 rounded bg-amber-100 px-1 py-0.5 text-[9px] font-semibold uppercase text-amber-800">
                Sealed
              </span>
            )}
          </span>
        </td>
        <td className="hidden px-3 py-2.5 md:table-cell">
          <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] capitalize text-muted-foreground">
            {docTypeLabel(doc.docType)}
          </span>
        </td>
        <td className="hidden px-3 py-2.5 text-right text-xs tabular-nums text-muted-foreground sm:table-cell">
          {doc.pageCount ?? "—"}
        </td>
        <td className="px-3 py-2.5 text-right text-xs tabular-nums text-muted-foreground">{formatBytes(doc.byteCount)}</td>
        <td className="hidden px-3 py-2.5 text-right lg:table-cell">
          <span
            className={`text-[10px] font-medium ${
              doc.textStatus === "done"
                ? "text-emerald-600"
                : doc.textStatus === "pending"
                  ? "text-amber-600"
                  : "text-muted-foreground/50"
            }`}
          >
            {doc.textStatus === "done" ? "extracted" : doc.textStatus === "pending" ? "pending" : "—"}
          </span>
        </td>
      </tr>
      {expanded && (
        <tr>
          <td colSpan={7} className="border-b bg-muted/20 p-0">
            <motion.div
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: "auto", opacity: 1 }}
              transition={{ duration: 0.25, ease: [0.32, 0.72, 0, 1] }}
              className="overflow-hidden"
            >
              <div className="p-3">
                <PdfViewer documentId={doc.id} title={doc.title} />
              </div>
            </motion.div>
          </td>
        </tr>
      )}
    </>
  );
});

// ---------------------------------------------------------------------------

function TableSkeleton({ cols }: { cols: number }) {
  return (
    <>
      {Array.from({ length: 8 }, (_, i) => (
        <tr key={i} className="border-b">
          {Array.from({ length: cols }, (_, j) => (
            <td key={j} className="px-3 py-3">
              <Skeleton className="h-3.5 w-full max-w-36" />
            </td>
          ))}
        </tr>
      ))}
    </>
  );
}

// ---------------------------------------------------------------------------

function Pager({
  page,
  pages,
  total,
  label,
  onPage,
}: {
  page: number;
  pages: number;
  total: number;
  label: string;
  onPage: (p: number) => void;
}) {
  return (
    <div className="flex shrink-0 items-center justify-between border-t bg-card px-4 py-1.5 text-xs text-muted-foreground md:px-6">
      <span>
        {total.toLocaleString()} {label} · page {page + 1} of {pages}
      </span>
      <div className="flex items-center gap-1">
        <Button variant="ghost" size="icon" className="h-7 w-7" disabled={page <= 0} onClick={() => onPage(page - 1)}>
          <ChevronLeft className="h-4 w-4" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7"
          disabled={page >= pages - 1}
          onClick={() => onPage(page + 1)}
        >
          <ChevronRight className="h-4 w-4" />
        </Button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------

function RightRail({ ws }: { ws: Workspace }) {
  const m = ws.matter;
  return (
    <ScrollArea className="h-full w-[272px]">
      <div className="w-[272px] space-y-5 p-3.5">
        <section>
          <h3 className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Matter</h3>
          <dl className="space-y-1.5 text-xs">
            <Field label="Court" value={m.courtName ?? m.courtId} />
            <Field label="Docket" value={m.docketNumber} />
            {m.mdlNumber && <Field label="MDL" value={`No. ${m.mdlNumber}`} />}
            {m.judge && <Field label="Judge" value={m.judge} />}
            {m.status && <Field label="Status" value={m.status} />}
            {m.stage && <Field label="Stage" value={m.stage} />}
            <Field label="Pipeline" value={m.pipelineStage} />
          </dl>
          <Separator className="my-3" />
          <div className="grid min-w-0 grid-cols-3 gap-1.5 text-center">
            <Stat label="Entries" value={m.entries} />
            <Stat label="Docs" value={m.documents} />
            <Stat label="With PDF" value={m.withPdf} />
          </div>
        </section>

        <section>
          <h3 className="mb-2 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
            <Users className="h-3 w-3 shrink-0" /> Parties ({ws.parties.length})
          </h3>
          {ws.parties.length === 0 ? (
            <p className="text-xs text-muted-foreground/60">Populated by the write stage.</p>
          ) : (
            <ul className="space-y-1">
              {ws.parties.slice(0, 30).map((p) => (
                <li key={p.id} className="min-w-0 text-xs">
                  <span className="truncate text-foreground">{p.name}</span>
                  {p.partyType && <span className="ml-1 capitalize text-muted-foreground">· {docTypeLabel(p.partyType)}</span>}
                </li>
              ))}
              {ws.parties.length > 30 && (
                <li className="text-[11px] text-muted-foreground">+ {ws.parties.length - 30} more</li>
              )}
            </ul>
          )}
        </section>

        <section>
          <h3 className="mb-2 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
            <Gavel className="h-3 w-3 shrink-0" /> Counsel ({ws.counsel.length})
          </h3>
          {ws.counsel.length === 0 ? (
            <p className="text-xs text-muted-foreground/60">Populated by the write stage.</p>
          ) : (
            <ul className="space-y-1.5">
              {ws.counsel.slice(0, 30).map((c) => (
                <li key={c.id} className="min-w-0 text-xs">
                  <span className="block truncate font-medium text-foreground">{c.attorney}</span>
                  {c.firm && <span className="block truncate text-muted-foreground">{c.firm}</span>}
                  {(c.role || c.partyName) && (
                    <span className="block truncate text-[11px] text-muted-foreground/70">
                      {c.role}
                      {c.role && c.partyName ? " · " : ""}
                      {c.partyName}
                    </span>
                  )}
                </li>
              ))}
              {ws.counsel.length > 30 && (
                <li className="text-[11px] text-muted-foreground">+ {ws.counsel.length - 30} more</li>
              )}
            </ul>
          )}
        </section>
      </div>
    </ScrollArea>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="shrink-0 text-muted-foreground">{label}</dt>
      <dd className="min-w-0 truncate text-right font-medium text-foreground">{value}</dd>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="min-w-0 rounded-md border bg-muted/30 px-1 py-1.5">
      <div className="truncate text-[13px] font-bold tabular-nums text-brand-navy">{value.toLocaleString()}</div>
      <div className="truncate text-[9px] uppercase tracking-wide text-muted-foreground">{label}</div>
    </div>
  );
}
