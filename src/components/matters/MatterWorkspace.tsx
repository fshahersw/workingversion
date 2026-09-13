// Matter workspace: dockets grouped by scope in a left rail, a filterable docket
// ledger in the middle, and an inline PDF pane on the right. No modals. Every
// label comes from the Aurora corpus plus the court reference table; nothing is
// inferred or decorative.
import { useEffect, useMemo, useState } from "react";
import { Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import {
  ArrowLeft,
  Calendar,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ExternalLink,
  FileText,
  Filter,
  Gavel,
  Loader2,
  Lock,
  Paperclip,
  Search,
  X,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Skeleton } from "@/components/ui/skeleton";
import { courtInfo } from "@/lib/courts";
import { getCourtResourceUrl } from "@/lib/workspace.functions";
import {
  SCOPE_LABEL,
  courtResourceKindLabel,
  courtResourcesQueryOptions,
  docTypeLabel,
  documentsQueryOptions,
  entriesQueryOptions,
  entryDocumentsQueryOptions,
  formatBytes,
  formatCorpusDate,
  formatCount,
  formatRelative,
  workspaceQueryOptions,
} from "@/lib/workspace";
import {
  COURT_RESOURCE_KINDS,
  DOCKET_SCOPES,
  type CourtIdentity,
  type CourtResource,
  type CourtResourceKind,
  type CourtResourceQuery,
  type DocketScope,
  type JudgeIdentity,
  type LedgerFilter,
  type LedgerSort,
  type MatterWorkspace as Workspace,
  type WorkspaceDocket,
  type WorkspaceDocument,
  type WorkspaceEntry,
} from "@/lib/workspace-types";

import { PdfViewer } from "./PdfViewer";

export type WorkspaceSearch = {
  view?: "ledger" | "documents" | "rules";
  q?: string;
  types?: string[];
  scope?: DocketScope;
  docket?: string;
  from?: string;
  to?: string;
  pdf?: true;
  hideSealed?: true;
  sort?: LedgerSort;
  entry?: string;
  doc?: string;
  page?: number;
  /** Rules & forms view: filter by document kind. */
  rkind?: CourtResourceKind;
  /** Rules & forms view: narrow to Word templates or PDFs. */
  rfmt?: "word" | "pdf";
};

type Patch = Partial<Record<keyof WorkspaceSearch, unknown>>;

const PAGE_SIZE = 50;

/** Total library documents the reference layer holds for a court. */
function courtResourceTotal(court: CourtIdentity): number {
  return COURT_RESOURCE_KINDS.reduce((sum, k) => sum + (court.resourceCounts[k] ?? 0), 0);
}

const SCOPE_DOT: Record<DocketScope, string> = {
  federal: "bg-brand-navy",
  jpml: "bg-brand-blue",
  member: "bg-teal-600",
  state: "bg-brand-orange",
  appellate: "bg-violet-600",
};

const SORT_OPTIONS: { value: LedgerSort; label: string }[] = [
  { value: "date-desc", label: "Newest filed" },
  { value: "date-asc", label: "Oldest filed" },
  { value: "entry-desc", label: "Entry, high to low" },
  { value: "entry-asc", label: "Entry, low to high" },
];

export function MatterWorkspace({
  slug,
  search,
  onSearch,
}: {
  slug: string;
  search: WorkspaceSearch;
  onSearch: (patch: Patch) => void;
}) {
  const { data: ws, isLoading, error } = useQuery(workspaceQueryOptions(slug));
  const [openDoc, setOpenDoc] = useState<WorkspaceDocument | null>(null);

  // Keep the pane's metadata in sync with the URL so a reload still shows a title.
  useEffect(() => {
    if (!search.doc) setOpenDoc(null);
    else if (openDoc && openDoc.id !== search.doc) setOpenDoc(null);
  }, [search.doc, openDoc]);

  const view = search.view ?? "ledger";

  const filter: LedgerFilter = useMemo(
    () => ({
      slug,
      search: search.q,
      types: search.types,
      scope: search.docket ? undefined : search.scope,
      docketId: search.docket,
      dateFrom: search.from,
      dateTo: search.to,
      onlyWithPdf: search.pdf,
      hideSealed: search.hideSealed,
      sort: search.sort ?? "date-desc",
      offset: ((search.page ?? 1) - 1) * PAGE_SIZE,
      limit: PAGE_SIZE,
    }),
    [slug, search],
  );

  const selectedDocket = useMemo(
    () => ws?.dockets.find((d) => d.docketId === search.docket) ?? null,
    [ws, search.docket],
  );

  const openDocument = (doc: WorkspaceDocument) => {
    setOpenDoc(doc);
    onSearch({ doc: doc.id });
  };
  const closeDocument = () => {
    setOpenDoc(null);
    onSearch({ doc: undefined });
  };

  if (error) {
    return (
      <div className="flex h-full items-center justify-center p-10 text-sm text-muted-foreground">
        {error instanceof Error ? error.message : "The matter could not be loaded."}
      </div>
    );
  }
  if (isLoading || !ws) return <WorkspaceSkeleton />;

  return (
    <div className="flex h-full min-h-0 flex-col bg-surface">
      <MatterHeader ws={ws} />
      <div className="flex min-h-0 flex-1">
        <DocketRail
          ws={ws}
          activeScope={search.docket ? undefined : search.scope}
          activeDocket={search.docket}
          onSelect={(patch) => onSearch({ ...patch, page: undefined, entry: undefined })}
        />
        <main className="flex min-w-0 flex-1 flex-col border-l border-border bg-card">
          {view === "rules" && ws.court ? (
            <CourtRulesView ws={ws} search={search} onSearch={onSearch} />
          ) : (
            <>
              <ContextBar
                ws={ws}
                scope={search.scope}
                docket={selectedDocket}
                onClear={() => onSearch({ scope: undefined, docket: undefined, page: undefined })}
              />
              <Toolbar
                ws={ws}
                search={search}
                onSearch={(p) => onSearch({ ...p, page: undefined })}
              />
              {view === "documents" ? (
                <DocumentsTable
                  filter={filter}
                  showDocket={!search.docket}
                  page={search.page ?? 1}
                  openId={search.doc}
                  onOpen={openDocument}
                  onPage={(page) => onSearch({ page: page > 1 ? page : undefined })}
                />
              ) : (
                <LedgerTable
                  slug={slug}
                  filter={filter}
                  showDocket={!search.docket}
                  page={search.page ?? 1}
                  expandedEntry={search.entry}
                  openId={search.doc}
                  onExpand={(id) => onSearch({ entry: id })}
                  onOpen={openDocument}
                  onPage={(page) => onSearch({ page: page > 1 ? page : undefined })}
                />
              )}
            </>
          )}
        </main>
        {search.doc && view !== "rules" && (
          <DocumentPane documentId={search.doc} doc={openDoc} onClose={closeDocument} />
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Header

function MatterHeader({ ws }: { ws: Workspace }) {
  const m = ws.matter;
  const court = courtInfo(m.courtId);
  const assignedJudge = ws.judges.find((j) => j.role === "assigned")?.name ?? null;
  return (
    <header className="shrink-0 border-b border-border bg-card px-6 pb-4 pt-4">
      <Link
        to="/matters"
        className="inline-flex items-center gap-1 text-[12px] font-medium text-muted-foreground transition-colors hover:text-brand-navy"
      >
        <ArrowLeft className="h-3.5 w-3.5" strokeWidth={2} />
        Matters
      </Link>
      <div className="mt-2 flex flex-wrap items-start justify-between gap-x-8 gap-y-3">
        <div className="min-w-0">
          <h1 className="font-display text-[26px] font-semibold leading-tight tracking-[-0.01em] text-brand-navy">
            {m.caseName}
          </h1>
          <div className="mt-2 flex flex-wrap items-center gap-x-2.5 gap-y-1.5 text-[13px] text-muted-foreground">
            {m.mdlNumber && (
              <span className="rounded-md bg-brand-navy px-2 py-0.5 text-[11.5px] font-semibold tracking-wide text-white">
                MDL {m.mdlNumber}
              </span>
            )}
            <span className="font-medium text-foreground">{court.label}</span>
            <span className="text-border">|</span>
            <span className="font-mono text-[12.5px]">{m.docketNumber}</span>
            {court.circuit && (
              <>
                <span className="text-border">|</span>
                <span>{court.circuit}</span>
              </>
            )}
            <span className="text-border">|</span>
            <span title={m.lastSyncedAt ?? undefined}>Synced {formatRelative(m.lastSyncedAt)}</span>
            {assignedJudge && (
              <>
                <span className="text-border">|</span>
                <span className="inline-flex items-center gap-1">
                  <Gavel className="h-3.5 w-3.5" strokeWidth={2} />
                  Hon. {assignedJudge}
                </span>
              </>
            )}
          </div>
        </div>
        <dl className="flex shrink-0 items-stretch divide-x divide-border rounded-lg border border-border bg-surface">
          <Stat label="Entries" value={m.entries} />
          <Stat label="Documents" value={m.documents} />
          <Stat label="PDFs" value={m.withPdf} />
          <Stat label="Sealed" value={m.sealed} />
        </dl>
      </div>
    </header>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="px-4 py-2 text-center">
      <dd className="font-display text-[19px] font-semibold leading-none tabular-nums text-brand-navy">
        {formatCount(value)}
      </dd>
      <dt className="mt-1 text-[10.5px] font-medium uppercase tracking-[0.08em] text-muted-foreground">
        {label}
      </dt>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Docket rail

function DocketRail({
  ws,
  activeScope,
  activeDocket,
  onSelect,
}: {
  ws: Workspace;
  activeScope?: DocketScope;
  activeDocket?: string;
  onSelect: (patch: Patch) => void;
}) {
  const groups = useMemo(() => {
    const by = new Map<DocketScope, WorkspaceDocket[]>();
    for (const d of ws.dockets) {
      const arr = by.get(d.scope) ?? [];
      arr.push(d);
      by.set(d.scope, arr);
    }
    return DOCKET_SCOPES.filter((s) => by.has(s)).map((s) => ({ scope: s, dockets: by.get(s)! }));
  }, [ws.dockets]);

  const allActive = !activeScope && !activeDocket;

  return (
    <aside className="flex w-[280px] shrink-0 flex-col overflow-hidden bg-surface">
      <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-6 pt-4">
        <RailRow
          active={allActive}
          onClick={() => onSelect({ scope: undefined, docket: undefined })}
          title="All dockets"
          meta={formatCount(ws.matter.documents)}
        />
        {groups.map((g) => (
          <RailGroup
            key={g.scope}
            scope={g.scope}
            dockets={g.dockets}
            files={ws.matter.scopeCounts[g.scope]?.files ?? 0}
            activeScope={activeScope}
            activeDocket={activeDocket}
            onSelect={onSelect}
          />
        ))}
      </div>
    </aside>
  );
}

function RailGroup({
  scope,
  dockets,
  files,
  activeScope,
  activeDocket,
  onSelect,
}: {
  scope: DocketScope;
  dockets: WorkspaceDocket[];
  files: number;
  activeScope?: DocketScope;
  activeDocket?: string;
  onSelect: (patch: Patch) => void;
}) {
  const many = dockets.length > 8;
  const [expanded, setExpanded] = useState(!many);
  const [q, setQ] = useState("");
  const label = SCOPE_LABEL[scope];

  const visible = useMemo(() => {
    const sorted = [...dockets].sort(
      (a, b) => Number(b.isLead) - Number(a.isLead) || b.filesPresent - a.filesPresent,
    );
    const t = q.trim().toLowerCase();
    const filtered = t
      ? sorted.filter((d) =>
          `${d.docketNumber} ${d.title ?? ""} ${courtInfo(d.courtId).short} ${courtInfo(d.courtId).label}`
            .toLowerCase()
            .includes(t),
        )
      : sorted;
    return expanded ? filtered : filtered.slice(0, 8);
  }, [dockets, expanded, q]);

  const groupActive = activeScope === scope && !activeDocket;

  return (
    <section className="mt-5">
      <button
        type="button"
        onClick={() => onSelect({ scope, docket: undefined })}
        title={label.hint}
        className={[
          "group flex w-full items-center gap-2 rounded-md px-2 py-1 text-left transition-colors",
          groupActive ? "bg-brand-blue-soft" : "hover:bg-card",
        ].join(" ")}
      >
        <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${SCOPE_DOT[scope]}`} />
        <span className="min-w-0 flex-1 truncate text-[10.5px] font-semibold uppercase tracking-[0.08em] text-muted-foreground group-hover:text-brand-navy">
          {scope === "member" ? "Member cases" : scope === "jpml" ? "JPML" : label.title}
        </span>
        <span className="shrink-0 text-[10.5px] tabular-nums text-muted-foreground">
          {dockets.length > 1 ? `${formatCount(dockets.length)} · ` : ""}
          {formatCount(files)}
        </span>
      </button>
      {many && (
        <div className="relative mt-1 px-2">
          <Search className="pointer-events-none absolute left-4 top-1/2 h-3 w-3 -translate-y-1/2 text-muted-foreground" />
          <input
            value={q}
            onChange={(e) => {
              setQ(e.target.value);
              if (e.target.value) setExpanded(true);
            }}
            placeholder={`Find among ${formatCount(dockets.length)} ${label.short.toLowerCase()}…`}
            className="h-7 w-full rounded-md border border-border bg-card pl-7 pr-2 text-[12px] outline-none placeholder:text-muted-foreground/70 focus:border-brand-blue"
          />
        </div>
      )}
      <ul className="mt-1">
        {visible.map((d) => (
          <DocketRow
            key={d.docketId}
            docket={d}
            active={activeDocket === d.docketId}
            onClick={() => onSelect({ docket: d.docketId, scope: undefined })}
          />
        ))}
      </ul>
      {many && !q && (
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="mt-1 flex w-full items-center gap-1 rounded-md px-2 py-1 text-[11.5px] font-medium text-brand-blue hover:bg-card"
        >
          <ChevronDown
            className={`h-3.5 w-3.5 transition-transform ${expanded ? "rotate-180" : ""}`}
          />
          {expanded ? "Show fewer" : `Show all ${formatCount(dockets.length)}`}
        </button>
      )}
    </section>
  );
}

function DocketRow({
  docket: d,
  active,
  onClick,
}: {
  docket: WorkspaceDocket;
  active: boolean;
  onClick: () => void;
}) {
  const court = courtInfo(d.courtId);
  const member = d.scope === "member";
  const tooltip = [
    court.name,
    d.title ? cleanTitle(d.title) : null,
    d.entryCount > 0
      ? `${formatCount(d.pdfAvailable)} of ${formatCount(d.entryCount)} entries on file`
      : null,
    d.followed ? "Auto-updating from DocketBird" : "Manual backfill",
  ]
    .filter(Boolean)
    .join("\n");
  return (
    <li>
      <button
        type="button"
        onClick={onClick}
        title={tooltip}
        className={[
          "flex w-full items-center gap-2 rounded-md px-2 py-[5px] text-left transition-colors",
          active ? "bg-card shadow-sm ring-1 ring-border" : "hover:bg-card/70",
        ].join(" ")}
      >
        <span className="w-[62px] shrink-0 truncate font-mono text-[10.5px] font-semibold text-brand-navy/80">
          {court.short}
        </span>
        {member ? (
          <span className="min-w-0 flex-1 truncate text-[12px] text-foreground">
            {d.title ? cleanTitle(d.title) : d.docketNumber}
          </span>
        ) : (
          <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-foreground">
            {d.docketNumber}
          </span>
        )}
        <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">
          {formatCount(d.filesPresent)}
        </span>
      </button>
    </li>
  );
}

function RailRow({
  active,
  onClick,
  title,
  meta,
}: {
  active: boolean;
  onClick: () => void;
  title: string;
  meta: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={[
        "flex w-full items-center gap-2 rounded-md px-2 py-[5px] text-left transition-colors",
        active ? "bg-card shadow-sm ring-1 ring-border" : "hover:bg-card/70",
      ].join(" ")}
    >
      <span className="min-w-0 flex-1 truncate text-[12.5px] font-semibold text-brand-navy">
        {title}
      </span>
      <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">{meta}</span>
    </button>
  );
}

function cleanTitle(t: string): string {
  return t
    .replace(/\s*DO NOT DOCKET.*$/i, "")
    .replace(/\s+/g, " ")
    .trim();
}

// ---------------------------------------------------------------------------
// Context bar (what is being shown)

function ContextBar({
  ws,
  scope,
  docket,
  onClear,
}: {
  ws: Workspace;
  scope?: DocketScope;
  docket: WorkspaceDocket | null;
  onClear: () => void;
}) {
  if (!docket && !scope) return null;
  if (docket) {
    const court = courtInfo(docket.courtId);
    const label = SCOPE_LABEL[docket.scope];
    return (
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-border bg-surface px-5 py-2.5 text-[12.5px]">
        <span className={`h-2 w-2 rounded-full ${SCOPE_DOT[docket.scope]}`} />
        <span className="font-semibold text-brand-navy">{label.short}</span>
        <span className="text-muted-foreground">{court.name}</span>
        <span className="font-mono text-foreground">{docket.docketNumber}</span>
        {docket.title && docket.scope === "member" && (
          <span className="truncate text-muted-foreground">{cleanTitle(docket.title)}</span>
        )}
        <span className="ml-auto flex items-center gap-3 text-muted-foreground">
          {docket.entryCount > 0 && (
            <span>
              {formatCount(docket.pdfAvailable)} of {formatCount(docket.entryCount)} entries on file
              {docket.sealedCount > 0 ? ` · ${formatCount(docket.sealedCount)} sealed` : ""}
            </span>
          )}
          <span
            className={
              docket.followed
                ? "rounded-full bg-emerald-50 px-2 py-0.5 text-[11px] font-medium text-emerald-700 ring-1 ring-emerald-200"
                : "rounded-full bg-muted px-2 py-0.5 text-[11px] font-medium text-muted-foreground ring-1 ring-border"
            }
            title={
              docket.followed
                ? "Followed in DocketBird; new filings sync automatically."
                : "Not followed in DocketBird; updated by manual backfill only."
            }
          >
            {docket.followed ? "Auto-updating" : "Manual"}
          </span>
          <span title={docket.lastSyncedAt ?? undefined}>
            Synced {formatRelative(docket.lastSyncedAt)}
          </span>
          <button
            type="button"
            onClick={onClear}
            className="rounded p-0.5 hover:bg-card"
            aria-label="Show all dockets"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </span>
      </div>
    );
  }
  const label = SCOPE_LABEL[scope!];
  const counts = ws.matter.scopeCounts[scope!];
  return (
    <div className="flex items-center gap-3 border-b border-border bg-surface px-5 py-2.5 text-[12.5px]">
      <span className={`h-2 w-2 rounded-full ${SCOPE_DOT[scope!]}`} />
      <span className="font-semibold text-brand-navy">{label.title}</span>
      <span className="text-muted-foreground">{label.hint}</span>
      <span className="ml-auto flex items-center gap-3 text-muted-foreground">
        <span>
          {formatCount(counts?.dockets ?? 0)} {counts?.dockets === 1 ? "docket" : "dockets"} ·{" "}
          {formatCount(counts?.files ?? 0)} documents
        </span>
        <button
          type="button"
          onClick={onClear}
          className="rounded p-0.5 hover:bg-card"
          aria-label="Show all dockets"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Toolbar

function Toolbar({
  ws,
  search,
  onSearch,
}: {
  ws: Workspace;
  search: WorkspaceSearch;
  onSearch: (p: Patch) => void;
}) {
  const [q, setQ] = useState(search.q ?? "");
  useEffect(() => setQ(search.q ?? ""), [search.q]);
  useEffect(() => {
    const t = setTimeout(() => {
      if ((q.trim() || undefined) !== search.q) onSearch({ q: q.trim() || undefined });
    }, 300);
    return () => clearTimeout(t);
  }, [q, search.q, onSearch]);

  const activeCount =
    (search.types?.length ?? 0) +
    (search.from || search.to ? 1 : 0) +
    (search.pdf ? 1 : 0) +
    (search.hideSealed ? 1 : 0);
  const view = search.view ?? "ledger";

  return (
    <div className="flex flex-wrap items-center gap-2 border-b border-border px-5 py-3">
      <ViewTabs view={view} ws={ws} onSelect={onSearch} />

      <div className="relative min-w-[220px] flex-1 max-w-md">
        <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
        <Input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search filings by title or entry number"
          className="h-8 pl-8 text-[13px]"
        />
        {q && (
          <button
            type="button"
            onClick={() => setQ("")}
            className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-0.5 text-muted-foreground hover:text-foreground"
            aria-label="Clear search"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        )}
      </div>

      <TypeFilter
        facets={ws.typeFacets}
        value={search.types ?? []}
        onChange={(types) => onSearch({ types: types.length ? types : undefined })}
      />

      <DateFilter
        from={search.from}
        to={search.to}
        range={ws.dateRange}
        onChange={(from, to) => onSearch({ from, to })}
      />

      <ToggleChip
        active={!!search.pdf}
        onClick={() => onSearch({ pdf: search.pdf ? undefined : true })}
        icon={<FileText className="h-3.5 w-3.5" />}
      >
        PDF on file
      </ToggleChip>
      <ToggleChip
        active={!!search.hideSealed}
        onClick={() => onSearch({ hideSealed: search.hideSealed ? undefined : true })}
        icon={<Lock className="h-3.5 w-3.5" />}
      >
        Hide sealed
      </ToggleChip>

      <select
        value={search.sort ?? "date-desc"}
        onChange={(e) => onSearch({ sort: e.target.value as LedgerSort })}
        aria-label="Sort"
        className="ml-auto h-8 rounded-md border border-border bg-card px-2 text-[12.5px] text-foreground outline-none focus:border-brand-blue"
      >
        {SORT_OPTIONS.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>

      {activeCount > 0 && (
        <button
          type="button"
          onClick={() =>
            onSearch({
              types: undefined,
              from: undefined,
              to: undefined,
              pdf: undefined,
              hideSealed: undefined,
            })
          }
          className="text-[12px] font-medium text-brand-blue hover:underline"
        >
          Clear filters
        </button>
      )}
    </div>
  );
}

function ToggleChip({
  active,
  onClick,
  icon,
  children,
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={[
        "inline-flex h-8 items-center gap-1.5 rounded-md border px-2.5 text-[12.5px] font-medium transition-colors",
        active
          ? "border-brand-navy/30 bg-brand-blue-soft text-brand-navy"
          : "border-border bg-card text-muted-foreground hover:text-brand-navy",
      ].join(" ")}
    >
      {icon}
      {children}
      {active && <Check className="h-3 w-3" />}
    </button>
  );
}

function TypeFilter({
  facets,
  value,
  onChange,
}: {
  facets: { type: string; count: number }[];
  value: string[];
  onChange: (v: string[]) => void;
}) {
  const toggle = (t: string) =>
    onChange(value.includes(t) ? value.filter((x) => x !== t) : [...value, t]);
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          className={[
            "inline-flex h-8 items-center gap-1.5 rounded-md border px-2.5 text-[12.5px] font-medium transition-colors",
            value.length
              ? "border-brand-navy/30 bg-brand-blue-soft text-brand-navy"
              : "border-border bg-card text-muted-foreground hover:text-brand-navy",
          ].join(" ")}
        >
          <Filter className="h-3.5 w-3.5" />
          {value.length ? `${value.length} ${value.length === 1 ? "type" : "types"}` : "Type"}
          <ChevronDown className="h-3 w-3" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-64 p-2">
        <div className="px-2 pb-1.5 pt-1 text-[10.5px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
          Document type
        </div>
        <ul className="max-h-72 overflow-y-auto">
          {facets.map((f) => {
            const on = value.includes(f.type);
            return (
              <li key={f.type}>
                <label className="flex cursor-pointer items-center gap-2.5 rounded-md px-2 py-1.5 text-[13px] hover:bg-muted">
                  <Checkbox
                    checked={on}
                    onCheckedChange={() => toggle(f.type)}
                    className="h-3.5 w-3.5"
                  />
                  <span className="min-w-0 flex-1 truncate">{docTypeLabel(f.type)}</span>
                  <span className="text-[11px] tabular-nums text-muted-foreground">
                    {formatCount(f.count)}
                  </span>
                </label>
              </li>
            );
          })}
        </ul>
        {value.length > 0 && (
          <button
            type="button"
            onClick={() => onChange([])}
            className="mt-1 w-full rounded-md px-2 py-1.5 text-left text-[12px] font-medium text-brand-blue hover:bg-muted"
          >
            Clear types
          </button>
        )}
      </PopoverContent>
    </Popover>
  );
}

function DateFilter({
  from,
  to,
  range,
  onChange,
}: {
  from?: string;
  to?: string;
  range: { first: string | null; last: string | null };
  onChange: (from: string | undefined, to: string | undefined) => void;
}) {
  const active = !!(from || to);
  const label = active
    ? `${from ? formatCorpusDate(from) : "…"} – ${to ? formatCorpusDate(to) : "…"}`
    : "Filed date";
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          className={[
            "inline-flex h-8 items-center gap-1.5 rounded-md border px-2.5 text-[12.5px] font-medium transition-colors",
            active
              ? "border-brand-navy/30 bg-brand-blue-soft text-brand-navy"
              : "border-border bg-card text-muted-foreground hover:text-brand-navy",
          ].join(" ")}
        >
          <Calendar className="h-3.5 w-3.5" />
          {label}
          <ChevronDown className="h-3 w-3" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-72 p-3">
        <div className="text-[10.5px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
          Filed between
        </div>
        <div className="mt-2 grid grid-cols-2 gap-2">
          <label className="text-[11.5px] text-muted-foreground">
            From
            <input
              type="date"
              value={from ?? ""}
              min={range.first ?? undefined}
              max={to ?? range.last ?? undefined}
              onChange={(e) => onChange(e.target.value || undefined, to)}
              className="mt-1 h-8 w-full rounded-md border border-border bg-card px-2 text-[12.5px] text-foreground outline-none focus:border-brand-blue"
            />
          </label>
          <label className="text-[11.5px] text-muted-foreground">
            To
            <input
              type="date"
              value={to ?? ""}
              min={from ?? range.first ?? undefined}
              max={range.last ?? undefined}
              onChange={(e) => onChange(from, e.target.value || undefined)}
              className="mt-1 h-8 w-full rounded-md border border-border bg-card px-2 text-[12.5px] text-foreground outline-none focus:border-brand-blue"
            />
          </label>
        </div>
        <div className="mt-2 text-[11px] text-muted-foreground">
          Filings on record: {formatCorpusDate(range.first)} – {formatCorpusDate(range.last)}
        </div>
        {active && (
          <button
            type="button"
            onClick={() => onChange(undefined, undefined)}
            className="mt-2 text-[12px] font-medium text-brand-blue hover:underline"
          >
            Clear dates
          </button>
        )}
      </PopoverContent>
    </Popover>
  );
}

// ---------------------------------------------------------------------------
// Ledger (docket entries)

function LedgerTable({
  slug,
  filter,
  showDocket,
  page,
  expandedEntry,
  openId,
  onExpand,
  onOpen,
  onPage,
}: {
  slug: string;
  filter: LedgerFilter;
  showDocket: boolean;
  page: number;
  expandedEntry?: string;
  openId?: string;
  onExpand: (id: string | undefined) => void;
  onOpen: (doc: WorkspaceDocument) => void;
  onPage: (page: number) => void;
}) {
  const { data, isLoading, isFetching } = useQuery(entriesQueryOptions(filter));
  const rows = data?.rows ?? [];
  const total = data?.total ?? 0;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto">
        <table className="w-full table-fixed border-collapse text-[13px]">
          <colgroup>
            <col className="w-[72px]" />
            <col className="w-[118px]" />
            <col />
            <col className="w-[150px]" />
            <col className="w-[64px]" />
            <col className="w-[110px]" />
          </colgroup>
          <thead className="sticky top-0 z-10 bg-card">
            <tr className="border-b border-border text-left text-[10.5px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
              <th className="px-3 py-2 pl-5">Entry</th>
              <th className="px-3 py-2">Filed</th>
              <th className="px-3 py-2">Description</th>
              <th className="px-3 py-2">Type</th>
              <th className="px-3 py-2 text-right">Docs</th>
              <th className="px-3 py-2 pr-5">Status</th>
            </tr>
          </thead>
          <tbody className={isFetching && !isLoading ? "opacity-60 transition-opacity" : ""}>
            {isLoading ? (
              Array.from({ length: 12 }).map((_, i) => (
                <tr key={i} className="border-b border-border/60">
                  <td colSpan={6} className="px-5 py-3">
                    <Skeleton className="h-4 w-full" />
                  </td>
                </tr>
              ))
            ) : rows.length === 0 ? (
              <tr>
                <td
                  colSpan={6}
                  className="px-5 py-16 text-center text-[13px] text-muted-foreground"
                >
                  No docket entries match these filters.
                </td>
              </tr>
            ) : (
              rows.map((e) => (
                <EntryRow
                  key={e.id}
                  slug={slug}
                  entry={e}
                  showDocket={showDocket}
                  expanded={expandedEntry === e.id}
                  openId={openId}
                  onToggle={() => onExpand(expandedEntry === e.id ? undefined : e.id)}
                  onOpen={onOpen}
                />
              ))
            )}
          </tbody>
        </table>
      </div>
      <Pager page={page} total={total} unit="entries" onPage={onPage} />
    </div>
  );
}

function EntryRow({
  slug,
  entry: e,
  showDocket,
  expanded,
  openId,
  onToggle,
  onOpen,
}: {
  slug: string;
  entry: WorkspaceEntry;
  showDocket: boolean;
  expanded: boolean;
  openId?: string;
  onToggle: () => void;
  onOpen: (doc: WorkspaceDocument) => void;
}) {
  const court = courtInfo(e.courtId);
  return (
    <>
      <tr
        onClick={onToggle}
        className={[
          "cursor-pointer border-b border-border/60 align-top transition-colors",
          expanded ? "bg-brand-blue-soft/40" : "hover:bg-surface",
        ].join(" ")}
      >
        <td className="px-3 py-2.5 pl-5 font-mono text-[12.5px] font-semibold tabular-nums text-brand-navy">
          {e.entryLabel}
        </td>
        <td className="px-3 py-2.5">
          <DateCell date={e.dateFiled} approx={e.dateApprox} />
        </td>
        <td className="px-3 py-2.5">
          <div className="line-clamp-2 leading-snug text-foreground">
            {e.description || <span className="text-muted-foreground">Untitled entry</span>}
          </div>
          {showDocket && (
            <div className="mt-1 flex items-center gap-1.5 text-[11px] text-muted-foreground">
              <span className={`h-1.5 w-1.5 rounded-full ${SCOPE_DOT[e.scope]}`} />
              <span className="font-medium">{court.short}</span>
              <span className="font-mono">{e.docketNumber}</span>
            </div>
          )}
        </td>
        <td className="px-3 py-2.5">
          <TypeBadge type={e.entryType} />
        </td>
        <td className="px-3 py-2.5 text-right tabular-nums text-muted-foreground">
          {e.documentCount}
        </td>
        <td className="px-3 py-2.5 pr-5">
          <StatusCell
            pdfCount={e.pdfCount}
            docCount={e.documentCount}
            sealedCount={e.sealedCount}
          />
        </td>
      </tr>
      {expanded && (
        <tr className="border-b border-border/60 bg-brand-blue-soft/25">
          <td colSpan={6} className="px-5 py-2">
            <AttachmentList slug={slug} entryId={e.id} openId={openId} onOpen={onOpen} />
          </td>
        </tr>
      )}
    </>
  );
}

function AttachmentList({
  slug,
  entryId,
  openId,
  onOpen,
}: {
  slug: string;
  entryId: string;
  openId?: string;
  onOpen: (doc: WorkspaceDocument) => void;
}) {
  const { data, isLoading } = useQuery(entryDocumentsQueryOptions(slug, entryId));
  if (isLoading) return <Skeleton className="my-1 h-4 w-1/2" />;
  const docs = data ?? [];
  if (!docs.length)
    return (
      <div className="py-1 text-[12px] text-muted-foreground">
        No documents recorded for this entry.
      </div>
    );
  return (
    <ul className="divide-y divide-border/50 rounded-md border border-border bg-card">
      {docs.map((d) => (
        <li key={d.id}>
          <DocumentLine doc={d} active={openId === d.id} onOpen={() => onOpen(d)} />
        </li>
      ))}
    </ul>
  );
}

function DocumentLine({
  doc: d,
  active,
  onOpen,
}: {
  doc: WorkspaceDocument;
  active: boolean;
  onOpen: () => void;
}) {
  const openable = d.hasPdf && !d.isSealed;
  return (
    <button
      type="button"
      onClick={openable ? onOpen : undefined}
      disabled={!openable}
      className={[
        "flex w-full items-center gap-3 px-3 py-2 text-left text-[12.5px] transition-colors",
        active ? "bg-brand-blue-soft" : openable ? "hover:bg-surface" : "cursor-default",
      ].join(" ")}
    >
      <span className="w-14 shrink-0 font-mono text-[11.5px] text-muted-foreground">
        {d.attachmentNumber > 0 ? `Att. ${d.attachmentNumber}` : "Main"}
      </span>
      {d.isSealed ? (
        <Lock className="h-3.5 w-3.5 shrink-0 text-brand-orange" />
      ) : d.hasPdf ? (
        <FileText className="h-3.5 w-3.5 shrink-0 text-brand-blue" />
      ) : (
        <Paperclip className="h-3.5 w-3.5 shrink-0 text-muted-foreground/60" />
      )}
      <span
        className={`min-w-0 flex-1 truncate ${openable ? "text-foreground" : "text-muted-foreground"}`}
      >
        {d.title || "Untitled document"}
      </span>
      <TypeBadge type={d.docType} />
      <span className="w-16 shrink-0 text-right text-[11px] tabular-nums text-muted-foreground">
        {d.isSealed ? "Sealed" : d.hasPdf ? formatBytes(d.byteCount) : "Text only"}
      </span>
    </button>
  );
}

// ---------------------------------------------------------------------------
// Documents view

function DocumentsTable({
  filter,
  showDocket,
  page,
  openId,
  onOpen,
  onPage,
}: {
  filter: LedgerFilter;
  showDocket: boolean;
  page: number;
  openId?: string;
  onOpen: (doc: WorkspaceDocument) => void;
  onPage: (page: number) => void;
}) {
  const { data, isLoading, isFetching } = useQuery(documentsQueryOptions(filter));
  const rows = data?.rows ?? [];
  const total = data?.total ?? 0;
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="min-h-0 flex-1 overflow-y-auto">
        <table className="w-full table-fixed border-collapse text-[13px]">
          <colgroup>
            <col className="w-[92px]" />
            <col className="w-[118px]" />
            <col />
            <col className="w-[150px]" />
            <col className="w-[72px]" />
            <col className="w-[110px]" />
          </colgroup>
          <thead className="sticky top-0 z-10 bg-card">
            <tr className="border-b border-border text-left text-[10.5px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
              <th className="px-3 py-2 pl-5">Entry</th>
              <th className="px-3 py-2">Filed</th>
              <th className="px-3 py-2">Document</th>
              <th className="px-3 py-2">Type</th>
              <th className="px-3 py-2 text-right">Size</th>
              <th className="px-3 py-2 pr-5">Status</th>
            </tr>
          </thead>
          <tbody className={isFetching && !isLoading ? "opacity-60 transition-opacity" : ""}>
            {isLoading ? (
              Array.from({ length: 12 }).map((_, i) => (
                <tr key={i} className="border-b border-border/60">
                  <td colSpan={6} className="px-5 py-3">
                    <Skeleton className="h-4 w-full" />
                  </td>
                </tr>
              ))
            ) : rows.length === 0 ? (
              <tr>
                <td
                  colSpan={6}
                  className="px-5 py-16 text-center text-[13px] text-muted-foreground"
                >
                  No documents match these filters.
                </td>
              </tr>
            ) : (
              rows.map((d) => {
                const court = courtInfo(d.courtId);
                const openable = d.hasPdf && !d.isSealed;
                return (
                  <tr
                    key={d.id}
                    onClick={openable ? () => onOpen(d) : undefined}
                    className={[
                      "border-b border-border/60 align-top transition-colors",
                      openId === d.id
                        ? "bg-brand-blue-soft/40"
                        : openable
                          ? "cursor-pointer hover:bg-surface"
                          : "",
                    ].join(" ")}
                  >
                    <td className="px-3 py-2.5 pl-5 font-mono text-[12.5px] tabular-nums">
                      <span className="font-semibold text-brand-navy">{d.entryLabel}</span>
                      {d.attachmentNumber > 0 && (
                        <span className="text-muted-foreground">-{d.attachmentNumber}</span>
                      )}
                    </td>
                    <td className="px-3 py-2.5">
                      <DateCell date={d.dateFiled} approx={d.dateApprox} />
                    </td>
                    <td className="px-3 py-2.5">
                      <div
                        className={`line-clamp-2 leading-snug ${openable ? "text-foreground" : "text-muted-foreground"}`}
                      >
                        {d.title || "Untitled document"}
                      </div>
                      {showDocket && (
                        <div className="mt-1 flex items-center gap-1.5 text-[11px] text-muted-foreground">
                          <span className={`h-1.5 w-1.5 rounded-full ${SCOPE_DOT[d.scope]}`} />
                          <span className="font-medium">{court.short}</span>
                          <span className="font-mono">{d.docketNumber}</span>
                        </div>
                      )}
                    </td>
                    <td className="px-3 py-2.5">
                      <TypeBadge type={d.docType} />
                    </td>
                    <td className="px-3 py-2.5 text-right tabular-nums text-muted-foreground">
                      {d.hasPdf ? formatBytes(d.byteCount) : "—"}
                    </td>
                    <td className="px-3 py-2.5 pr-5">
                      <StatusCell
                        pdfCount={d.hasPdf ? 1 : 0}
                        docCount={1}
                        sealedCount={d.isSealed ? 1 : 0}
                      />
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
      <Pager page={page} total={total} unit="documents" onPage={onPage} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Cells

function DateCell({ date, approx }: { date: string | null; approx: boolean }) {
  if (!date) return <span className="text-muted-foreground">—</span>;
  return (
    <span
      className={`whitespace-nowrap tabular-nums ${approx ? "text-muted-foreground" : "text-foreground"}`}
      title={
        approx
          ? "Docket filing date; this document's own date has not been captured yet."
          : undefined
      }
    >
      {approx ? "≈ " : ""}
      {formatCorpusDate(date)}
    </span>
  );
}

function TypeBadge({ type }: { type: string | null }) {
  const key = (type || "other").toLowerCase();
  const tone =
    key === "order" || key === "cmo" || key === "opinion" || key === "transfer_order"
      ? "bg-brand-navy/[0.07] text-brand-navy"
      : key === "complaint"
        ? "bg-brand-orange-soft text-brand-orange"
        : key === "motion" || key === "brief"
          ? "bg-brand-blue-soft text-brand-blue"
          : "bg-muted text-muted-foreground";
  return (
    <span
      className={`inline-block max-w-full truncate rounded px-1.5 py-0.5 text-[11px] font-medium ${tone}`}
    >
      {docTypeLabel(type)}
    </span>
  );
}

function StatusCell({
  pdfCount,
  docCount,
  sealedCount,
}: {
  pdfCount: number;
  docCount: number;
  sealedCount: number;
}) {
  if (sealedCount > 0 && pdfCount === 0) {
    return (
      <span className="inline-flex items-center gap-1 text-[11.5px] font-medium text-brand-orange">
        <Lock className="h-3.5 w-3.5" /> Sealed
      </span>
    );
  }
  if (pdfCount === 0) return <span className="text-[11.5px] text-muted-foreground">Text only</span>;
  return (
    <span className="inline-flex items-center gap-1 text-[11.5px] font-medium text-brand-blue">
      <FileText className="h-3.5 w-3.5" />
      {pdfCount === docCount ? "PDF" : `${pdfCount}/${docCount} PDF`}
      {sealedCount > 0 && <Lock className="ml-1 h-3 w-3 text-brand-orange" />}
    </span>
  );
}

function Pager({
  page,
  total,
  unit,
  onPage,
}: {
  page: number;
  total: number;
  unit: string;
  onPage: (p: number) => void;
}) {
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const start = total === 0 ? 0 : (page - 1) * PAGE_SIZE + 1;
  const end = Math.min(page * PAGE_SIZE, total);
  return (
    <div className="flex shrink-0 items-center justify-between border-t border-border px-5 py-2 text-[12px] text-muted-foreground">
      <span className="tabular-nums">
        {total === 0
          ? `0 ${unit}`
          : `${formatCount(start)}–${formatCount(end)} of ${formatCount(total)} ${unit}`}
      </span>
      <div className="flex items-center gap-1">
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7"
          disabled={page <= 1}
          onClick={() => onPage(page - 1)}
          aria-label="Previous page"
        >
          <ChevronLeft className="h-4 w-4" />
        </Button>
        <span className="tabular-nums">
          Page {formatCount(page)} of {formatCount(pages)}
        </span>
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7"
          disabled={page >= pages}
          onClick={() => onPage(page + 1)}
          aria-label="Next page"
        >
          <ChevronRight className="h-4 w-4" />
        </Button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Document pane

function DocumentPane({
  documentId,
  doc,
  onClose,
}: {
  documentId: string;
  doc: WorkspaceDocument | null;
  onClose: () => void;
}) {
  const court = doc ? courtInfo(doc.courtId) : null;
  return (
    <aside className="flex w-[46%] min-w-[420px] shrink-0 flex-col border-l border-border bg-surface">
      <div className="flex items-start gap-3 border-b border-border bg-card px-4 py-3">
        <div className="min-w-0 flex-1">
          <div className="truncate text-[13.5px] font-semibold text-brand-navy">
            {doc?.title || "Document"}
          </div>
          {doc && (
            <div className="mt-0.5 flex flex-wrap items-center gap-x-2 text-[11.5px] text-muted-foreground">
              {court && <span className="font-medium">{court.short}</span>}
              <span className="font-mono">{doc.docketNumber}</span>
              <span>
                Entry {doc.entryLabel}
                {doc.attachmentNumber > 0 ? `-${doc.attachmentNumber}` : ""}
              </span>
              {doc.dateFiled && (
                <span>
                  {doc.dateApprox ? "≈ " : ""}
                  {formatCorpusDate(doc.dateFiled)}
                </span>
              )}
              <TypeBadge type={doc.docType} />
            </div>
          )}
        </div>
        <button
          type="button"
          onClick={onClose}
          className="rounded p-1 text-muted-foreground hover:bg-surface hover:text-foreground"
          aria-label="Close document"
        >
          <X className="h-4 w-4" />
        </button>
      </div>
      <div className="min-h-0 flex-1 p-3">
        <PdfViewer documentId={documentId} title={doc?.title} fill />
      </div>
    </aside>
  );
}

// ---------------------------------------------------------------------------
// Rules & forms (court reference library)

function ViewTabs({
  view,
  ws,
  onSelect,
}: {
  view: "ledger" | "documents" | "rules";
  ws: Workspace;
  onSelect: (p: Patch) => void;
}) {
  const tabs = [
    { v: "ledger" as const, label: "Docket entries", badge: 0 },
    { v: "documents" as const, label: "Documents", badge: 0 },
    ...(ws.court
      ? [{ v: "rules" as const, label: "Rules & forms", badge: courtResourceTotal(ws.court) }]
      : []),
  ];
  return (
    <div className="inline-flex rounded-md border border-border bg-surface p-0.5 text-[12.5px] font-medium">
      {tabs.map((t) => (
        <button
          key={t.v}
          type="button"
          onClick={() => onSelect({ view: t.v === "ledger" ? undefined : t.v, entry: undefined })}
          className={[
            "inline-flex items-center gap-1.5 rounded px-3 py-1 transition-colors",
            view === t.v
              ? "bg-card text-brand-navy shadow-sm"
              : "text-muted-foreground hover:text-brand-navy",
          ].join(" ")}
        >
          {t.label}
          {t.badge > 0 && (
            <span className="rounded-full bg-brand-blue-soft px-1.5 text-[10.5px] tabular-nums text-brand-blue">
              {formatCount(t.badge)}
            </span>
          )}
        </button>
      ))}
    </div>
  );
}

function CourtRulesView({
  ws,
  search,
  onSearch,
}: {
  ws: Workspace;
  search: WorkspaceSearch;
  onSearch: (p: Patch) => void;
}) {
  const court = ws.court!;
  const page = search.page ?? 1;
  const query: CourtResourceQuery = useMemo(
    () => ({
      courtKeys: court.keys,
      ...(search.rkind ? { kind: search.rkind } : {}),
      ...(search.rfmt ? { format: search.rfmt } : {}),
      ...(search.q ? { search: search.q } : {}),
      page,
      pageSize: PAGE_SIZE,
    }),
    [court.keys, search.rkind, search.rfmt, search.q, page],
  );
  const { data, isLoading, isFetching } = useQuery(courtResourcesQueryOptions(query));
  const rows = data?.items ?? [];
  const total = data?.total ?? 0;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <CourtRulesToolbar
        ws={ws}
        search={search}
        onSearch={(p) => onSearch({ ...p, page: undefined })}
      />
      <div className="min-h-0 flex-1 overflow-y-auto">
        <CourtIdentityCard court={court} judges={ws.judges} />
        <table className="w-full table-fixed border-collapse text-[13px]">
          <colgroup>
            <col className="w-[132px]" />
            <col />
            <col className="w-[64px]" />
            <col className="w-[84px]" />
            <col className="w-[104px]" />
          </colgroup>
          <thead className="sticky top-0 z-10 bg-card">
            <tr className="border-b border-border text-left text-[10.5px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
              <th className="px-3 py-2 pl-5">Type</th>
              <th className="px-3 py-2">Title</th>
              <th className="px-3 py-2">Format</th>
              <th className="px-3 py-2 text-right">Size</th>
              <th className="px-3 py-2 pr-5">Open</th>
            </tr>
          </thead>
          <tbody className={isFetching && !isLoading ? "opacity-60 transition-opacity" : ""}>
            {isLoading ? (
              Array.from({ length: 10 }).map((_, i) => (
                <tr key={i} className="border-b border-border/60">
                  <td colSpan={5} className="px-5 py-3">
                    <Skeleton className="h-4 w-full" />
                  </td>
                </tr>
              ))
            ) : rows.length === 0 ? (
              <tr>
                <td
                  colSpan={5}
                  className="px-5 py-16 text-center text-[13px] text-muted-foreground"
                >
                  No rules, standing orders or forms match these filters.
                </td>
              </tr>
            ) : (
              rows.map((r) => <CourtResourceRow key={r.sha256} r={r} />)
            )}
          </tbody>
        </table>
      </div>
      <Pager
        page={page}
        total={total}
        unit="documents"
        onPage={(p) => onSearch({ page: p > 1 ? p : undefined })}
      />
    </div>
  );
}

const RULES_FORMATS: { value: "" | "word" | "pdf"; label: string }[] = [
  { value: "", label: "All" },
  { value: "word", label: "Word" },
  { value: "pdf", label: "PDF" },
];

function CourtRulesToolbar({
  ws,
  search,
  onSearch,
}: {
  ws: Workspace;
  search: WorkspaceSearch;
  onSearch: (p: Patch) => void;
}) {
  const [q, setQ] = useState(search.q ?? "");
  useEffect(() => setQ(search.q ?? ""), [search.q]);
  useEffect(() => {
    const t = setTimeout(() => {
      if ((q.trim() || undefined) !== search.q) onSearch({ q: q.trim() || undefined });
    }, 300);
    return () => clearTimeout(t);
  }, [q, search.q, onSearch]);
  const view = search.view ?? "rules";

  return (
    <div className="flex flex-wrap items-center gap-2 border-b border-border px-5 py-3">
      <ViewTabs view={view} ws={ws} onSelect={onSearch} />

      <div className="relative min-w-[220px] max-w-md flex-1">
        <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
        <Input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search rules, standing orders and forms"
          className="h-8 pl-8 text-[13px]"
        />
        {q && (
          <button
            type="button"
            onClick={() => setQ("")}
            className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-0.5 text-muted-foreground hover:text-foreground"
            aria-label="Clear search"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        )}
      </div>

      <select
        value={search.rkind ?? ""}
        onChange={(e) =>
          onSearch({ rkind: (e.target.value || undefined) as CourtResourceKind | undefined })
        }
        aria-label="Document type"
        className="h-8 rounded-md border border-border bg-card px-2 text-[12.5px] text-foreground outline-none focus:border-brand-blue"
      >
        <option value="">All types</option>
        {COURT_RESOURCE_KINDS.map((k) => (
          <option key={k} value={k}>
            {courtResourceKindLabel(k)}
          </option>
        ))}
      </select>

      <div className="inline-flex rounded-md border border-border bg-surface p-0.5 text-[12.5px] font-medium">
        {RULES_FORMATS.map((f) => {
          const active = (search.rfmt ?? "") === f.value;
          return (
            <button
              key={f.value || "all"}
              type="button"
              onClick={() => onSearch({ rfmt: f.value || undefined })}
              className={[
                "rounded px-3 py-1 transition-colors",
                active
                  ? "bg-card text-brand-navy shadow-sm"
                  : "text-muted-foreground hover:text-brand-navy",
              ].join(" ")}
            >
              {f.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function CourtIdentityCard({ court, judges }: { court: CourtIdentity; judges: JudgeIdentity[] }) {
  return (
    <div className="border-b border-border bg-surface px-5 py-4">
      <div className="flex items-start gap-4">
        <CourtMark court={court} />
        <div className="min-w-0 flex-1">
          <div className="text-[15px] font-semibold leading-tight text-brand-navy">{court.name}</div>
          <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[12px] text-muted-foreground">
            <span>{court.level}</span>
            <span className="text-border">|</span>
            <span>{court.jurisdiction}</span>
            {court.website && (
              <>
                <span className="text-border">|</span>
                <a
                  href={court.website}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1 text-brand-blue hover:underline"
                >
                  Court website
                  <ExternalLink className="h-3 w-3" />
                </a>
              </>
            )}
          </div>
        </div>
        {judges.length > 0 && (
          <div className="flex shrink-0 flex-wrap items-center justify-end gap-4">
            {judges.map((j) => (
              <JudgeChip key={`${j.role}:${j.name}`} judge={j} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function CourtMark({ court }: { court: CourtIdentity }) {
  const [broken, setBroken] = useState(false);
  if (court.logoUrl && !broken) {
    return (
      <div
        className={[
          "flex h-14 w-14 shrink-0 items-center justify-center overflow-hidden rounded-md border border-border",
          court.logoBackground === "dark" ? "bg-brand-navy" : "bg-white",
        ].join(" ")}
      >
        <img
          src={court.logoUrl}
          alt=""
          className="h-full w-full object-contain p-1"
          onError={() => setBroken(true)}
        />
      </div>
    );
  }
  return (
    <div className="flex h-14 w-14 shrink-0 items-center justify-center rounded-md border border-border bg-brand-blue-soft text-[15px] font-semibold text-brand-navy">
      {court.fallbackText}
    </div>
  );
}

function JudgeChip({ judge: j }: { judge: JudgeIdentity }) {
  const [broken, setBroken] = useState(false);
  return (
    <div className="flex items-center gap-2">
      {j.portraitUrl && !broken ? (
        <img
          src={j.portraitUrl}
          alt=""
          className="h-9 w-9 rounded-full object-cover ring-1 ring-border"
          onError={() => setBroken(true)}
        />
      ) : (
        <div className="flex h-9 w-9 items-center justify-center rounded-full bg-muted text-muted-foreground ring-1 ring-border">
          <Gavel className="h-4 w-4" />
        </div>
      )}
      <div className="leading-tight">
        <div className="text-[12.5px] font-medium text-foreground">{j.name}</div>
        <div className="text-[10px] uppercase tracking-[0.07em] text-muted-foreground">
          {j.role === "assigned" ? "Assigned judge" : "Referred judge"}
        </div>
      </div>
    </div>
  );
}

function CourtKindBadge({ kind }: { kind: CourtResourceKind }) {
  const tone =
    kind === "standing_order" || kind === "order"
      ? "bg-brand-navy/[0.07] text-brand-navy"
      : kind === "local_rule" || kind === "instruction"
        ? "bg-brand-blue-soft text-brand-blue"
        : kind === "form"
          ? "bg-brand-orange-soft text-brand-orange"
          : "bg-muted text-muted-foreground";
  return (
    <span
      className={`inline-block whitespace-nowrap rounded px-1.5 py-0.5 text-[11px] font-medium ${tone}`}
    >
      {courtResourceKindLabel(kind)}
    </span>
  );
}

function CourtResourceRow({ r }: { r: CourtResource }) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [portraitBroken, setPortraitBroken] = useState(false);
  const provenance = [r.sourceDateKind, r.sourceDate].filter(Boolean).join(" ");

  const open = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await getCourtResourceUrl({ data: { sha256: r.sha256 } });
      if (res?.url) window.open(res.url, "_blank", "noopener,noreferrer");
      else setError("Unavailable");
    } catch {
      setError("Failed to open");
    } finally {
      setLoading(false);
    }
  };

  return (
    <tr className="border-b border-border/60 align-top transition-colors hover:bg-surface">
      <td className="px-3 py-2.5 pl-5">
        <CourtKindBadge kind={r.kind} />
      </td>
      <td className="px-3 py-2.5">
        <div className="line-clamp-2 leading-snug text-foreground">{r.title}</div>
        {(r.judgeName || provenance || r.fillable) && (
          <div className="mt-1 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-[11px] text-muted-foreground">
            {r.judgeName && (
              <span className="inline-flex items-center gap-1">
                {r.judgePortraitUrl && !portraitBroken ? (
                  <img
                    src={r.judgePortraitUrl}
                    alt=""
                    className="h-4 w-4 rounded-full object-cover"
                    onError={() => setPortraitBroken(true)}
                  />
                ) : (
                  <Gavel className="h-3 w-3" />
                )}
                {r.judgeName}
              </span>
            )}
            {provenance && <span>{provenance}</span>}
            {r.fillable && (
              <span className="rounded bg-brand-blue-soft px-1.5 py-0.5 text-brand-blue">
                Fillable
              </span>
            )}
          </div>
        )}
      </td>
      <td className="px-3 py-2.5 text-[11.5px] uppercase text-muted-foreground">{r.format}</td>
      <td className="px-3 py-2.5 text-right tabular-nums text-muted-foreground">
        {r.pageCount ? `${formatCount(r.pageCount)} p` : formatBytes(r.bytes)}
      </td>
      <td className="px-3 py-2.5 pr-5">
        <button
          type="button"
          onClick={open}
          disabled={loading}
          className="inline-flex items-center gap-1 rounded-md border border-border bg-card px-2 py-1 text-[12px] font-medium text-brand-navy transition-colors hover:bg-surface disabled:opacity-60"
        >
          {loading ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <ExternalLink className="h-3.5 w-3.5" />
          )}
          Open
        </button>
        {error && <div className="mt-1 text-[10.5px] text-brand-orange">{error}</div>}
      </td>
    </tr>
  );
}

// ---------------------------------------------------------------------------

function WorkspaceSkeleton() {
  return (
    <div className="flex h-full flex-col bg-surface">
      <div className="border-b border-border bg-card px-6 py-5">
        <Skeleton className="h-3 w-16" />
        <Skeleton className="mt-3 h-7 w-2/3" />
        <Skeleton className="mt-3 h-4 w-1/2" />
      </div>
      <div className="flex flex-1">
        <div className="w-[300px] space-y-2 p-4">
          {Array.from({ length: 8 }).map((_, i) => (
            <Skeleton key={i} className="h-8 w-full" />
          ))}
        </div>
        <div className="flex-1 space-y-3 border-l border-border bg-card p-5">
          {Array.from({ length: 12 }).map((_, i) => (
            <Skeleton key={i} className="h-5 w-full" />
          ))}
        </div>
      </div>
    </div>
  );
}
