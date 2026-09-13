// Matters landing: the firm's active MDL matters as a browsable list. Clicking a
// row opens that matter's workspace. Counts and sync times come straight from the
// Aurora corpus; scope chips show how the matter's dockets break down.
import { useMemo, useState } from "react";
import { Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { ChevronRight, Search } from "lucide-react";

import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { courtInfo } from "@/lib/courts";
import { SCOPE_LABEL, formatCount, formatRelative, mattersQueryOptions } from "@/lib/workspace";
import { DOCKET_SCOPES, type DocketScope, type MatterListItem } from "@/lib/workspace-types";

const SCOPE_DOT: Record<DocketScope, string> = {
  federal: "bg-brand-navy",
  jpml: "bg-brand-blue",
  member: "bg-teal-600",
  state: "bg-brand-orange",
  appellate: "bg-violet-600",
};

export function MattersIndex() {
  const { data, isLoading, error } = useQuery(mattersQueryOptions);
  const [q, setQ] = useState("");
  const matters = useMemo(() => data ?? [], [data]);

  const filtered = useMemo(() => {
    const t = q.trim().toLowerCase();
    if (!t) return matters;
    return matters.filter((m) =>
      `${m.caseName} ${m.docketNumber} ${m.mdlNumber ?? ""} ${courtInfo(m.courtId).label}`
        .toLowerCase()
        .includes(t),
    );
  }, [matters, q]);

  const totals = useMemo(
    () =>
      matters.reduce((acc, m) => ({ docs: acc.docs + m.documents, pdfs: acc.pdfs + m.withPdf }), {
        docs: 0,
        pdfs: 0,
      }),
    [matters],
  );

  return (
    <div className="h-full overflow-y-auto bg-surface">
      <div className="mx-auto max-w-5xl px-6 py-10">
        <div className="flex flex-wrap items-end justify-between gap-4">
          <div>
            <h1 className="font-display text-[30px] font-semibold tracking-[-0.01em] text-brand-navy">
              Matters
            </h1>
            <p className="mt-1 text-[13px] text-muted-foreground">
              {isLoading
                ? "Loading…"
                : `${matters.length} active ${matters.length === 1 ? "matter" : "matters"} · ${formatCount(totals.docs)} documents · ${formatCount(totals.pdfs)} PDFs on file`}
            </p>
          </div>
          <div className="relative w-full max-w-xs">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search by name, court, docket, or MDL"
              className="h-9 bg-card pl-9"
            />
          </div>
        </div>

        {error ? (
          <div className="mt-8 rounded-xl border border-border bg-card px-5 py-16 text-center text-sm text-muted-foreground">
            {error instanceof Error ? error.message : "Matters could not be loaded."}
          </div>
        ) : (
          <div className="mt-6 overflow-hidden rounded-xl border border-border bg-card shadow-sm">
            {isLoading ? (
              <div className="divide-y divide-border/60">
                {Array.from({ length: 6 }).map((_, i) => (
                  <div key={i} className="px-5 py-4">
                    <Skeleton className="h-5 w-2/3" />
                    <Skeleton className="mt-2 h-3 w-1/3" />
                  </div>
                ))}
              </div>
            ) : filtered.length === 0 ? (
              <div className="px-5 py-20 text-center text-sm text-muted-foreground">
                {matters.length === 0
                  ? "No matters yet. Backfilled matters will appear here."
                  : "No matters match your search."}
              </div>
            ) : (
              <ul className="divide-y divide-border/60">
                {filtered.map((m) => (
                  <li key={m.slug}>
                    <MatterRow matter={m} />
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function MatterRow({ matter: m }: { matter: MatterListItem }) {
  const court = courtInfo(m.courtId);
  const scopes = DOCKET_SCOPES.filter((s) => (m.scopeCounts[s]?.dockets ?? 0) > 0);
  return (
    <Link
      to="/matters/$slug"
      params={{ slug: m.slug }}
      className="group grid grid-cols-[1fr_auto] items-center gap-x-6 gap-y-2 px-5 py-4 transition-colors hover:bg-brand-blue-soft/40 md:grid-cols-[1fr_minmax(220px,auto)_auto]"
    >
      <div className="min-w-0">
        <div className="flex min-w-0 items-center gap-2.5">
          {m.mdlNumber && (
            <span className="shrink-0 rounded bg-brand-navy px-1.5 py-0.5 text-[10.5px] font-semibold tracking-wide text-white">
              MDL {m.mdlNumber}
            </span>
          )}
          <span className="truncate font-display text-[17px] font-semibold text-brand-navy">
            {m.caseName}
          </span>
        </div>
        <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[12px] text-muted-foreground">
          <span className="font-medium text-foreground/80">{court.label}</span>
          <span className="text-border">|</span>
          <span className="font-mono">{m.docketNumber}</span>
          <span className="text-border">|</span>
          <span>Synced {formatRelative(m.lastSyncedAt)}</span>
        </div>
      </div>

      <div className="hidden flex-wrap items-center justify-end gap-1.5 md:flex">
        {scopes.map((s) => (
          <span
            key={s}
            title={SCOPE_LABEL[s].title}
            className="inline-flex items-center gap-1.5 rounded-full border border-border bg-surface px-2 py-0.5 text-[11px] text-muted-foreground"
          >
            <span className={`h-1.5 w-1.5 rounded-full ${SCOPE_DOT[s]}`} />
            {SCOPE_LABEL[s].short}
            {m.scopeCounts[s].dockets > 1 && (
              <span className="tabular-nums text-foreground/70">
                {formatCount(m.scopeCounts[s].dockets)}
              </span>
            )}
          </span>
        ))}
      </div>

      <div className="flex items-center gap-5 justify-self-end">
        <div className="text-right">
          <div className="font-display text-[17px] font-semibold leading-none tabular-nums text-brand-navy">
            {formatCount(m.documents)}
          </div>
          <div className="mt-1 text-[10.5px] font-medium uppercase tracking-[0.08em] text-muted-foreground">
            documents
          </div>
        </div>
        <div className="hidden text-right sm:block">
          <div className="font-display text-[17px] font-semibold leading-none tabular-nums text-brand-navy">
            {formatCount(m.withPdf)}
          </div>
          <div className="mt-1 text-[10.5px] font-medium uppercase tracking-[0.08em] text-muted-foreground">
            PDFs
          </div>
        </div>
        <ChevronRight className="h-4 w-4 text-muted-foreground/60 transition-transform group-hover:translate-x-0.5 group-hover:text-brand-navy" />
      </div>
    </Link>
  );
}
