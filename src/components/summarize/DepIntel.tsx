import { AlertTriangle, ArrowRight, Loader2, MessageSquareText, Pin } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import {
  displayCite,
  type DepAnalysis,
  type DepGraphNode,
  type DepSide,
} from "@/lib/pile/deposition-analysis";
import {
  compareWitnesses,
  intelSummary,
  labelFor,
  priorityQueue,
  sharedEntities,
  witnessColumns,
  witnessProfiles,
  type IntelIssue,
  type Severity,
  type WitnessCol,
} from "@/lib/pile/dep-intel";
import { KIND_HEX } from "@/lib/pile/graph-view";
import type { DepPass, DepPassStatus } from "@/lib/use-deposition";

export type IntelJumpTab = "witnesses" | "contradictions" | "graph" | "admissions" | "exhibits";

export type TranscriptMeta = { fileId: string; fileName: string; witness?: string | null };

type CiteFn = (cite: string, fileName?: string) => void;

const SEV_CLASS: Record<Severity, string> = {
  high: "bg-destructive/10 text-destructive",
  medium: "bg-amber-50 text-amber-800",
  low: "bg-slate-100 text-slate-600",
};

const KIND_LABEL: Record<IntelIssue["kind"], string> = {
  conflict: "Conflict",
  omission: "Omission",
  gap: "30(b)(6) gap",
};

const PILL = "border px-2 py-0.5 text-[10.5px] font-medium transition-colors";
const PILL_ON = "border-brand-navy bg-brand-navy text-white";
const PILL_OFF = "border-border bg-card text-slate-600 hover:text-slate-900";

const QUEUE_PAGE = 10;
const QUEUE_STEP = 20;
const ENTITY_PAGE = 12;
const ENTITY_STEP = 24;
const CHIP_CAP = 24;
/** Compare is shown by default up to this many witnesses; beyond it, on demand. */
const AUTO_COMPARE_MAX = 4;

function SectionHead({
  title,
  hint,
  right,
}: {
  title: string;
  hint?: string;
  right?: React.ReactNode;
}) {
  return (
    <div className="mb-2 flex flex-wrap items-end justify-between gap-2">
      <div className="min-w-0">
        <h3 className="text-[11px] font-semibold uppercase tracking-[0.12em] text-slate-500">
          {title}
        </h3>
        {hint ? <p className="mt-0.5 text-[11.5px] leading-snug text-slate-500">{hint}</p> : null}
      </div>
      {right ? <div className="flex shrink-0 flex-wrap items-center gap-1.5">{right}</div> : null}
    </div>
  );
}

function Kpi({
  n,
  label,
  sub,
  tone,
  onClick,
}: {
  n: number | string;
  label: string;
  sub?: string;
  tone?: "conflict" | "agree";
  onClick?: () => void;
}) {
  const Tag = onClick ? "button" : "div";
  return (
    <Tag
      type={onClick ? "button" : undefined}
      onClick={onClick}
      className={`min-w-[6.5rem] flex-1 border border-border bg-card px-3 py-2.5 text-left ${
        onClick ? "transition-colors hover:border-brand-navy/30 hover:bg-surface" : ""
      }`}
    >
      <p
        className={`text-[17px] font-semibold tabular-nums leading-none ${
          tone === "conflict"
            ? "text-destructive"
            : tone === "agree"
              ? "text-emerald-700"
              : "text-slate-900"
        }`}
      >
        {n}
      </p>
      <p className="mt-1 text-[11px] text-slate-500">{label}</p>
      {sub ? <p className="text-[10.5px] text-slate-400">{sub}</p> : null}
    </Tag>
  );
}

function WitnessChip({
  label,
  fileName,
  active,
}: {
  label: string;
  fileName: string;
  active?: boolean;
}) {
  return (
    <span
      title={fileName}
      className={`inline-block max-w-[9rem] truncate px-1.5 py-0.5 text-[10.5px] font-medium ${
        active ? "bg-brand-navy text-white" : "bg-slate-100 text-slate-600"
      }`}
    >
      {label}
    </span>
  );
}

function Bar({ pct, tone }: { pct: number; tone?: "conflict" | "agree" }) {
  const fill =
    tone === "conflict" ? "bg-destructive" : tone === "agree" ? "bg-emerald-600" : "bg-brand-navy";
  return (
    <span className="inline-block h-1.5 w-16 overflow-hidden bg-slate-100 align-middle">
      <span
        className={`block h-full ${fill}`}
        style={{ width: `${Math.max(0, Math.min(100, pct))}%` }}
      />
    </span>
  );
}

function CiteBtn({ cite, fileName, onCite }: { cite: string; fileName?: string; onCite: CiteFn }) {
  if (!cite) return <span className="text-slate-300">—</span>;
  return (
    <button
      type="button"
      onClick={() => onCite(cite, fileName)}
      title={fileName ? `${fileName} · ${displayCite(cite)}` : displayCite(cite)}
      className="inline-flex items-center gap-1 bg-brand-navy/8 px-1.5 py-0.5 font-mono text-[11px] text-brand-navy hover:bg-brand-navy/15"
    >
      <Pin className="h-3 w-3" />
      {displayCite(cite)}
    </button>
  );
}

function SideLine({ side, label, onCite }: { side: DepSide; label: string; onCite: CiteFn }) {
  return (
    <div className="flex items-start gap-2 text-[12px]">
      <span className="shrink-0 font-medium text-slate-700">{side.witness || label}</span>
      {side.quote ? (
        <span className="min-w-0 flex-1 italic text-slate-600">“{side.quote}”</span>
      ) : null}
      <CiteBtn cite={side.cite} fileName={side.fileName} onCite={onCite} />
    </div>
  );
}

function ShowMore({
  remaining,
  step,
  onClick,
}: {
  remaining: number;
  step: number;
  onClick: () => void;
}) {
  if (remaining <= 0) return null;
  return (
    <button
      type="button"
      onClick={onClick}
      className="mt-2 text-[11.5px] font-medium text-brand-navy hover:underline"
    >
      Show {Math.min(step, remaining)} more
    </button>
  );
}

function KindDot({ kind }: { kind: DepGraphNode["kind"] }) {
  return (
    <span
      aria-hidden
      className="inline-block h-2 w-2 shrink-0"
      style={{ backgroundColor: KIND_HEX[kind] }}
    />
  );
}

function AskButton({ onClick, children }: { onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="inline-flex items-center gap-1.5 border border-border bg-card px-2.5 py-1 text-[11.5px] font-medium text-slate-700 transition-colors hover:border-brand-navy/30 hover:text-slate-900"
    >
      <MessageSquareText className="h-3 w-3" />
      {children}
    </button>
  );
}

/* ------------------------------------------------------------------------- */

function QueueTable({
  issues,
  labelOf,
  onCite,
  onOpenTab,
  onAsk,
}: {
  issues: IntelIssue[];
  labelOf: (fileName: string) => string;
  onCite: CiteFn;
  onOpenTab: (tab: IntelJumpTab) => void;
  onAsk?: (question: string) => void;
}) {
  const [filter, setFilter] = useState<Severity | null>(null);
  const [shown, setShown] = useState(QUEUE_PAGE);
  const counts = useMemo(
    () => ({
      high: issues.filter((issue) => issue.severity === "high").length,
      medium: issues.filter((issue) => issue.severity === "medium").length,
      low: issues.filter((issue) => issue.severity === "low").length,
    }),
    [issues],
  );
  const rows = filter ? issues.filter((issue) => issue.severity === filter) : issues;
  if (!issues.length) return null;

  return (
    <section data-testid="intel-queue">
      <SectionHead
        title="Priority queue"
        hint="Every adjudicated conflict, omission, and 30(b)(6) gap, ranked by how hard it hits."
        right={
          <>
            <button
              type="button"
              onClick={() => setFilter(null)}
              className={`${PILL} ${filter === null ? PILL_ON : PILL_OFF}`}
            >
              All {issues.length}
            </button>
            {(["high", "medium", "low"] as Severity[]).map((severity) =>
              counts[severity] ? (
                <button
                  key={severity}
                  type="button"
                  onClick={() => setFilter((current) => (current === severity ? null : severity))}
                  className={`${PILL} ${filter === severity ? PILL_ON : PILL_OFF}`}
                >
                  {severity[0]!.toUpperCase() + severity.slice(1)} {counts[severity]}
                </button>
              ) : null,
            )}
          </>
        }
      />
      <div className="overflow-x-auto border border-border bg-card">
        <table className="w-full min-w-[40rem] text-[12px]">
          <thead>
            <tr className="border-b border-border bg-surface text-left text-[10.5px] font-semibold uppercase tracking-[0.08em] text-slate-500">
              <th className="w-8 px-3 py-2">#</th>
              <th className="px-2 py-2">Issue</th>
              <th className="px-2 py-2">Type</th>
              <th className="px-2 py-2">Witnesses</th>
              <th className="px-2 py-2">Where</th>
              {onAsk ? <th className="w-10 px-2 py-2" /> : null}
            </tr>
          </thead>
          <tbody className="divide-y divide-border/70">
            {rows.slice(0, shown).map((issue, index) => (
              <tr key={issue.id} className="align-top hover:bg-surface/70">
                <td className="px-3 py-2 tabular-nums text-slate-400">{index + 1}</td>
                <td className="px-2 py-2">
                  <div className="flex items-start gap-2">
                    <span
                      className={`mt-0.5 shrink-0 px-1.5 py-0.5 text-[9.5px] font-semibold uppercase tracking-[0.08em] ${SEV_CLASS[issue.severity]}`}
                    >
                      {issue.severity}
                    </span>
                    <div className="min-w-0">
                      <p className="font-medium leading-snug text-slate-900">{issue.title}</p>
                      {issue.detail ? (
                        <p className="mt-0.5 line-clamp-2 text-[11.5px] leading-snug text-slate-500">
                          {issue.detail}
                        </p>
                      ) : null}
                    </div>
                  </div>
                </td>
                <td className="whitespace-nowrap px-2 py-2">
                  <button
                    type="button"
                    onClick={() =>
                      onOpenTab(issue.kind === "gap" ? "admissions" : "contradictions")
                    }
                    className="text-slate-600 underline-offset-2 hover:text-brand-navy hover:underline"
                  >
                    {KIND_LABEL[issue.kind]}
                  </button>
                </td>
                <td className="px-2 py-2">
                  <div className="flex flex-wrap gap-1">
                    {issue.files.length ? (
                      issue.files.map((fileName) => (
                        <WitnessChip key={fileName} label={labelOf(fileName)} fileName={fileName} />
                      ))
                    ) : (
                      <span className="text-slate-300">—</span>
                    )}
                  </div>
                </td>
                <td className="whitespace-nowrap px-2 py-2">
                  <div className="flex flex-wrap items-center gap-1">
                    <CiteBtn
                      cite={issue.cite}
                      fileName={issue.fileName || undefined}
                      onCite={onCite}
                    />
                    {issue.other ? (
                      <CiteBtn
                        cite={issue.other.cite}
                        fileName={issue.other.fileName || undefined}
                        onCite={onCite}
                      />
                    ) : null}
                  </div>
                </td>
                {onAsk ? (
                  <td className="px-2 py-2">
                    <button
                      type="button"
                      aria-label={`Ask every witness about ${issue.title}`}
                      title="Ask every witness about this"
                      onClick={() =>
                        onAsk(
                          `Across every witness, what does the testimony say about: ${issue.title}? Quote each witness and note where they agree or disagree.`,
                        )
                      }
                      className="grid h-6 w-6 place-items-center text-slate-400 hover:bg-surface hover:text-brand-navy"
                    >
                      <MessageSquareText className="h-3.5 w-3.5" />
                    </button>
                  </td>
                ) : null}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <ShowMore
        remaining={rows.length - shown}
        step={QUEUE_STEP}
        onClick={() => setShown((n) => n + QUEUE_STEP)}
      />
    </section>
  );
}

function CentralityTable({
  analysis,
  cols,
  onCompare,
}: {
  analysis: DepAnalysis;
  cols: WitnessCol[];
  onCompare: (a: string, b: string) => void;
}) {
  const profiles = useMemo(() => witnessProfiles(analysis, cols), [analysis, cols]);
  const labelOf = labelFor(cols);
  if (profiles.length < 2) return null;
  return (
    <section data-testid="intel-centrality">
      <SectionHead
        title="Witness centrality"
        hint="Who sits at the center of the record: shared entities, agreements, and conflicts tie witnesses together."
      />
      <div className="overflow-x-auto border border-border bg-card">
        <table className="w-full min-w-[36rem] text-[12px]">
          <thead>
            <tr className="border-b border-border bg-surface text-left text-[10.5px] font-semibold uppercase tracking-[0.08em] text-slate-500">
              <th className="px-3 py-2">Witness</th>
              <th className="px-2 py-2 text-right" title="Entities another witness also reaches">
                Shared
              </th>
              <th className="px-2 py-2 text-right">Conflicts</th>
              <th className="px-2 py-2 text-right">Agree</th>
              <th className="px-2 py-2">Connected to</th>
              <th className="px-2 py-2">Centrality</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border/70">
            {profiles.map((profile) => (
              <tr key={profile.fileName} className="hover:bg-surface/70">
                <td className="px-3 py-2">
                  <p className="font-medium text-slate-900">{profile.label}</p>
                  <p
                    className="max-w-[14rem] truncate text-[10.5px] text-slate-400"
                    title={profile.fileName}
                  >
                    {profile.fileName}
                  </p>
                </td>
                <td className="px-2 py-2 text-right tabular-nums text-slate-700">
                  {profile.shared}
                  <span className="text-slate-400">/{profile.entities}</span>
                </td>
                <td className="px-2 py-2 text-right tabular-nums text-destructive">
                  {profile.conflicts || <span className="text-slate-300">—</span>}
                </td>
                <td className="px-2 py-2 text-right tabular-nums text-emerald-700">
                  {profile.corroborations || <span className="text-slate-300">—</span>}
                </td>
                <td className="px-2 py-2">
                  {profile.connectedTo.length ? (
                    <div className="flex flex-wrap gap-1">
                      {profile.connectedTo.map((fileName) => (
                        <button
                          key={fileName}
                          type="button"
                          onClick={() => onCompare(profile.fileName, fileName)}
                          title={`Compare ${profile.label} with ${labelOf(fileName)}`}
                          className="bg-slate-100 px-1.5 py-0.5 text-[10.5px] font-medium text-slate-600 hover:bg-brand-navy hover:text-white"
                        >
                          {labelOf(fileName)}
                        </button>
                      ))}
                    </div>
                  ) : (
                    <span className="text-[11px] text-slate-400">Isolated</span>
                  )}
                </td>
                <td className="whitespace-nowrap px-2 py-2">
                  <Bar pct={profile.centrality} />
                  <span className="ml-2 tabular-nums text-slate-700">{profile.centrality}</span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function NodeChips({
  nodes,
  onOpenGraph,
}: {
  nodes: DepGraphNode[];
  onOpenGraph: (nodeId: string) => void;
}) {
  if (!nodes.length) return <p className="text-[11.5px] text-slate-400">None</p>;
  const shown = nodes.slice(0, CHIP_CAP);
  return (
    <div className="flex flex-wrap gap-1">
      {shown.map((node) => (
        <button
          key={node.id}
          type="button"
          onClick={() => onOpenGraph(node.id)}
          title={`Open ${node.label} in the connections map`}
          className="inline-flex max-w-full items-center gap-1.5 border border-border bg-card px-1.5 py-0.5 text-[11px] text-slate-700 hover:border-brand-navy/40 hover:text-slate-900"
        >
          <KindDot kind={node.kind} />
          <span className="truncate">{node.label}</span>
        </button>
      ))}
      {nodes.length > CHIP_CAP ? (
        <span className="px-1 py-0.5 text-[11px] text-slate-400">+{nodes.length - CHIP_CAP}</span>
      ) : null}
    </div>
  );
}

function Compare({
  analysis,
  cols,
  pair,
  onPair,
  onCite,
  onOpenGraph,
  onAsk,
}: {
  analysis: DepAnalysis;
  cols: WitnessCol[];
  pair: [string, string];
  onPair: (pair: [string, string]) => void;
  onCite: CiteFn;
  onOpenGraph: (nodeId: string) => void;
  onAsk?: (question: string) => void;
}) {
  const labelOf = labelFor(cols);
  const [a, b] = pair;
  const cmp = useMemo(() => compareWitnesses(analysis, a, b, cols), [analysis, a, b, cols]);
  const labelA = labelOf(a);
  const labelB = labelOf(b);

  const select = (which: 0 | 1, value: string) => {
    const next: [string, string] = [...pair] as [string, string];
    next[which] = value;
    onPair(next);
  };

  return (
    <section data-testid="intel-compare" id="dep-intel-compare">
      <SectionHead
        title="Compare two witnesses"
        hint="Everything the pair has in common, everything they dispute, and what each says alone."
        right={
          <>
            <select
              aria-label="First witness"
              value={a}
              onChange={(e) => select(0, e.target.value)}
              className="h-7 border border-border bg-card px-2 text-[11.5px]"
            >
              {cols.map((col) => (
                <option key={col.fileName} value={col.fileName} disabled={col.fileName === b}>
                  {col.label}
                </option>
              ))}
            </select>
            <span className="text-[11px] text-slate-400">vs</span>
            <select
              aria-label="Second witness"
              value={b}
              onChange={(e) => select(1, e.target.value)}
              className="h-7 border border-border bg-card px-2 text-[11.5px]"
            >
              {cols.map((col) => (
                <option key={col.fileName} value={col.fileName} disabled={col.fileName === a}>
                  {col.label}
                </option>
              ))}
            </select>
          </>
        }
      />

      <div className="grid gap-2 lg:grid-cols-3">
        <div className="border border-border bg-card p-3">
          <p className="mb-2 text-[11px] font-semibold text-slate-700">
            Both mention <span className="tabular-nums text-slate-400">· {cmp.shared.length}</span>
          </p>
          <NodeChips nodes={cmp.shared} onOpenGraph={onOpenGraph} />
        </div>
        <div className="border border-border bg-surface p-3">
          <p className="mb-2 text-[11px] font-semibold text-slate-700">
            Only {labelA} <span className="tabular-nums text-slate-400">· {cmp.onlyA.length}</span>
          </p>
          <NodeChips nodes={cmp.onlyA} onOpenGraph={onOpenGraph} />
        </div>
        <div className="border border-border bg-surface p-3">
          <p className="mb-2 text-[11px] font-semibold text-slate-700">
            Only {labelB} <span className="tabular-nums text-slate-400">· {cmp.onlyB.length}</span>
          </p>
          <NodeChips nodes={cmp.onlyB} onOpenGraph={onOpenGraph} />
        </div>
      </div>

      <div className="mt-2 grid gap-2 lg:grid-cols-2">
        <div className="border border-destructive/25 bg-destructive/5 p-3">
          <p className="mb-2 text-[11px] font-semibold text-destructive">
            They disagree <span className="tabular-nums opacity-70">· {cmp.conflicts.length}</span>
          </p>
          {cmp.conflicts.length ? (
            <ul className="space-y-2.5">
              {cmp.conflicts.map((item) => (
                <li key={item.id}>
                  <p className="text-[12.5px] font-medium leading-snug text-slate-900">
                    {item.title}
                  </p>
                  {item.summary ? (
                    <p className="mt-0.5 text-[11.5px] leading-snug text-slate-600">
                      {item.summary}
                    </p>
                  ) : null}
                  <div className="mt-1.5 space-y-1">
                    <SideLine side={item.a} label={labelOf(item.a.fileName)} onCite={onCite} />
                    <SideLine side={item.b} label={labelOf(item.b.fileName)} onCite={onCite} />
                  </div>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-[11.5px] text-slate-500">
              No adjudicated conflict between these two.
            </p>
          )}
        </div>
        <div className="border border-emerald-700/25 bg-emerald-50/60 p-3">
          <p className="mb-2 text-[11px] font-semibold text-emerald-800">
            They agree{" "}
            <span className="tabular-nums opacity-70">· {cmp.corroborations.length}</span>
          </p>
          {cmp.corroborations.length ? (
            <ul className="space-y-1.5">
              {cmp.corroborations.map((edge, index) => {
                const from = analysis.graph.nodes.find((node) => node.id === edge.from);
                const to = analysis.graph.nodes.find((node) => node.id === edge.to);
                return (
                  <li
                    key={`${edge.from}|${edge.to}|${index}`}
                    className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[12px]"
                  >
                    <span className="font-medium text-slate-800">{from?.label ?? edge.from}</span>
                    <span className="text-slate-500">{edge.label}</span>
                    <span className="font-medium text-slate-800">{to?.label ?? edge.to}</span>
                    <CiteBtn cite={edge.cite} onCite={onCite} />
                  </li>
                );
              })}
            </ul>
          ) : (
            <p className="text-[11.5px] text-slate-500">
              No adjudicated agreement between these two.
            </p>
          )}
        </div>
      </div>

      {onAsk ? (
        <div className="mt-2">
          <AskButton
            onClick={() =>
              onAsk(
                `Where do ${labelA} and ${labelB} disagree, and where do they corroborate each other? Quote both witnesses with page and line.`,
              )
            }
          >
            Ask about these two
          </AskButton>
        </div>
      ) : null}
    </section>
  );
}

function Entities({
  analysis,
  cols,
  onOpenGraph,
}: {
  analysis: DepAnalysis;
  cols: WitnessCol[];
  onOpenGraph: (nodeId: string) => void;
}) {
  const [shown, setShown] = useState(ENTITY_PAGE);
  const rows = useMemo(() => sharedEntities(analysis, cols), [analysis, cols]);
  const labelOf = labelFor(cols);
  if (!rows.length) return null;
  return (
    <section data-testid="intel-entities">
      <SectionHead
        title="Recurring entities"
        hint="People, organizations, documents, and events that more than one witness talks about. Click to open the dossier."
        right={<span className="text-[11px] tabular-nums text-slate-400">{rows.length}</span>}
      />
      <ul className="grid gap-1.5 sm:grid-cols-2">
        {rows.slice(0, shown).map((row) => (
          <li key={row.node.id}>
            <button
              type="button"
              onClick={() => onOpenGraph(row.node.id)}
              className="flex w-full items-center gap-2 border border-border bg-card px-2.5 py-2 text-left transition-colors hover:border-brand-navy/40"
            >
              <KindDot kind={row.node.kind} />
              <span className="min-w-0 flex-1 truncate text-[12.5px] font-medium text-slate-900">
                {row.node.label}
              </span>
              {row.conflicted ? (
                <AlertTriangle
                  aria-label="In a conflict"
                  className="h-3.5 w-3.5 shrink-0 text-destructive"
                />
              ) : null}
              <span className="flex shrink-0 flex-wrap justify-end gap-1">
                {row.files.map((fileName) => (
                  <span
                    key={fileName}
                    title={fileName}
                    className="bg-slate-100 px-1.5 py-0.5 text-[10px] font-medium text-slate-600"
                  >
                    {labelOf(fileName)}
                    {row.mentions[fileName] ? ` ×${row.mentions[fileName]}` : ""}
                  </span>
                ))}
              </span>
              <span className="shrink-0 text-[10.5px] tabular-nums text-slate-400">
                {row.degree} links
              </span>
            </button>
          </li>
        ))}
      </ul>
      <ShowMore
        remaining={rows.length - shown}
        step={ENTITY_STEP}
        onClick={() => setShown((n) => n + ENTITY_STEP)}
      />
    </section>
  );
}

/* ------------------------------------------------------------------------- */

export function DepIntel({
  analysis,
  transcripts,
  passes,
  onCite,
  onOpenTab,
  onOpenGraph,
  onAsk,
}: {
  analysis: DepAnalysis;
  transcripts: TranscriptMeta[];
  passes: Record<DepPass, DepPassStatus>;
  onCite: CiteFn;
  onOpenTab: (tab: IntelJumpTab) => void;
  onOpenGraph: (nodeId: string) => void;
  onAsk?: (question: string) => void;
}) {
  const refs = useMemo(
    () => transcripts.map((t) => ({ fileName: t.fileName, witness: t.witness ?? null })),
    [transcripts],
  );
  const cols = useMemo(() => witnessColumns(analysis, refs), [analysis, refs]);
  const multi = cols.length > 1;
  const summary = useMemo(() => intelSummary(analysis, refs), [analysis, refs]);
  const queue = useMemo(() => priorityQueue(analysis), [analysis]);
  const labelOf = labelFor(cols);

  const [pair, setPair] = useState<[string, string]>([
    cols[0]?.fileName ?? "",
    cols[1]?.fileName ?? cols[0]?.fileName ?? "",
  ]);
  useEffect(() => {
    // Keep the pair valid when transcripts are added or removed.
    const names = new Set(cols.map((col) => col.fileName));
    setPair((current) => {
      const a = names.has(current[0]) ? current[0] : (cols[0]?.fileName ?? "");
      let b = names.has(current[1]) && current[1] !== a ? current[1] : "";
      if (!b) b = cols.find((col) => col.fileName !== a)?.fileName ?? a;
      return a === current[0] && b === current[1] ? current : [a, b];
    });
  }, [cols]);
  const pairOk = multi && pair[0] !== pair[1] && !!pair[0] && !!pair[1];
  const [compareOpen, setCompareOpen] = useState(cols.length <= AUTO_COMPARE_MAX);

  const pairing = passes.cross === "running" || passes.connections === "running";
  const empty =
    !analysis.contradictions.length && !analysis.graph.nodes.length && !analysis.admissions.length;

  const openCompare = (a: string, b: string) => {
    setPair([a, b]);
    setCompareOpen(true);
    window.requestAnimationFrame(() => {
      document
        .getElementById("dep-intel-compare")
        ?.scrollIntoView({ behavior: "smooth", block: "start" });
    });
  };

  return (
    <div className="space-y-6" data-testid="dep-intel">
      <div className="flex flex-wrap gap-2" data-testid="intel-kpis">
        <Kpi
          n={summary.witnesses}
          label={summary.witnesses === 1 ? "Witness" : "Witnesses"}
          onClick={() => onOpenTab("witnesses")}
        />
        <Kpi
          n={summary.entities}
          label="Entities"
          sub={multi ? `${summary.shared} shared` : undefined}
          onClick={() => onOpenTab("graph")}
        />
        <Kpi
          n={summary.conflicts}
          label="Conflicts"
          sub={summary.high ? `${summary.high} high` : undefined}
          tone="conflict"
          onClick={() => onOpenTab("contradictions")}
        />
        <Kpi n={summary.corroborations} label="Agreements" tone="agree" />
        <Kpi n={summary.edges} label="Links" />
      </div>

      {pairing ? (
        <p className="flex items-center gap-2 text-[12px] text-slate-500">
          <Loader2 className="h-3.5 w-3.5 motion-safe:animate-spin" />
          Pairing similar testimony across witnesses. Agreements and conflicts fill in as the
          adjudicator finishes.
        </p>
      ) : null}

      {empty && !pairing ? (
        <p className="border border-dashed border-border px-4 py-6 text-center text-[12.5px] text-slate-500">
          Cross-deposition intelligence appears once the analysis has findings to compare.
        </p>
      ) : null}

      <QueueTable
        issues={queue}
        labelOf={labelOf}
        onCite={onCite}
        onOpenTab={onOpenTab}
        onAsk={onAsk}
      />

      {multi ? (
        <CentralityTable analysis={analysis} cols={cols} onCompare={openCompare} />
      ) : !empty ? (
        <p className="border border-border bg-surface px-4 py-3 text-[12px] leading-relaxed text-slate-600">
          Load a second transcript into this set to unlock witness centrality, side-by-side
          comparison, and recurring entities across witnesses.
        </p>
      ) : null}

      {multi && pairOk ? (
        compareOpen ? (
          <Compare
            analysis={analysis}
            cols={cols}
            pair={pair}
            onPair={setPair}
            onCite={onCite}
            onOpenGraph={onOpenGraph}
            onAsk={onAsk}
          />
        ) : (
          <button
            type="button"
            onClick={() => setCompareOpen(true)}
            className="inline-flex items-center gap-1.5 border border-border bg-card px-3 py-1.5 text-[12px] font-medium text-slate-700 hover:border-brand-navy/30"
          >
            Compare two witnesses
            <ArrowRight className="h-3.5 w-3.5" />
          </button>
        )
      ) : null}

      {multi ? <Entities analysis={analysis} cols={cols} onOpenGraph={onOpenGraph} /> : null}

      {analysis.graph.nodes.length ? (
        <p className="flex flex-wrap items-center gap-x-2 gap-y-1 border-t border-border pt-3 text-[11.5px] text-slate-500">
          Every entity above opens in the connections map, where red edges are conflicts and dashed
          green edges are corroborating witnesses.
          <button
            type="button"
            onClick={() => onOpenTab("graph")}
            className="inline-flex items-center gap-1 font-medium text-brand-navy hover:underline"
          >
            Open the map
            <ArrowRight className="h-3 w-3" />
          </button>
        </p>
      ) : null}
    </div>
  );
}
