import { useMemo, useState } from "react";

import { displayCite, type DepAnalysis, type DepGraphNode } from "@/lib/pile/deposition-analysis";

const KIND_LABEL: Record<DepGraphNode["kind"], string> = {
  person: "Person",
  org: "Org",
  doc: "Doc",
  theme: "Theme",
  event: "Event",
};

const KIND_CARD: Record<DepGraphNode["kind"], string> = {
  person: "border-l-brand-navy bg-white",
  org: "border-l-brand-orange bg-white",
  doc: "border-l-slate-500 bg-white",
  theme: "border-l-emerald-700 bg-white",
  event: "border-l-amber-700 bg-white",
};

const KIND_DOT: Record<DepGraphNode["kind"], string> = {
  person: "bg-brand-navy",
  org: "bg-brand-orange",
  doc: "bg-slate-500",
  theme: "bg-emerald-700",
  event: "bg-amber-700",
};

const KIND_ORDER: DepGraphNode["kind"][] = ["person", "org", "doc", "theme", "event"];

const CARD_W = 188;
const CARD_H = 70;
const COL_W = 220;
const ROW_H = 92;
const PAD_X = 36;
const PAD_Y = 44;

type Laid = { id: string; label: string; kind: DepGraphNode["kind"]; x: number; y: number };

function wrapLabel(label: string, max = 20): string[] {
  const words = label.replace(/\s+/g, " ").trim().split(" ");
  const lines: string[] = [];
  let cur = "";
  for (const w of words) {
    const next = cur ? `${cur} ${w}` : w;
    if (next.length > max && cur) {
      lines.push(cur);
      cur = w;
      if (lines.length === 1) break;
    } else {
      cur = next;
    }
  }
  if (cur && lines.length < 2) lines.push(cur);
  else if (cur && lines.length === 1) lines[0] = `${lines[0]}…`;
  if (lines[1] && lines[1].length > max) lines[1] = `${lines[1].slice(0, max - 1)}…`;
  return lines.length ? lines : [label.slice(0, max)];
}

function layout(nodes: DepGraphNode[]): { items: Laid[]; width: number; height: number } {
  const cols: Record<DepGraphNode["kind"], DepGraphNode[]> = {
    person: [],
    org: [],
    doc: [],
    theme: [],
    event: [],
  };
  for (const n of nodes) cols[n.kind].push(n);
  const used = KIND_ORDER.filter((k) => cols[k].length);
  const maxRows = Math.max(1, ...used.map((k) => cols[k].length));
  const width = PAD_X * 2 + Math.max(1, used.length) * COL_W;
  const height = Math.max(300, PAD_Y * 2 + maxRows * ROW_H);
  const items: Laid[] = [];
  used.forEach((kind, col) => {
    const list = cols[kind];
    list.forEach((n, i) => {
      const spread = list.length > 1 ? (height - PAD_Y * 2 - CARD_H) / (list.length - 1) : 0;
      items.push({
        id: n.id,
        label: n.label,
        kind,
        x: PAD_X + col * COL_W + CARD_W / 2,
        y: PAD_Y + CARD_H / 2 + (list.length > 1 ? spread * i : (height - PAD_Y * 2 - CARD_H) / 2),
      });
    });
  });
  return { items, width, height };
}

export function KnowledgeGraph({
  analysis,
  onCite,
}: {
  analysis: DepAnalysis;
  onCite: (cite: string, fileName?: string) => void;
}) {
  const [active, setActive] = useState<string | null>(null);
  const [hover, setHover] = useState<string | null>(null);
  const [kindFilter, setKindFilter] = useState<DepGraphNode["kind"] | null>(null);
  const { items, width, height } = useMemo(
    () => layout(analysis.graph.nodes),
    [analysis.graph.nodes],
  );
  const byId = useMemo(() => new Map(items.map((n) => [n.id, n])), [items]);
  const degree = useMemo(() => {
    const map = new Map<string, number>();
    for (const e of analysis.graph.edges) {
      map.set(e.from, (map.get(e.from) ?? 0) + 1);
      map.set(e.to, (map.get(e.to) ?? 0) + 1);
    }
    return map;
  }, [analysis.graph.edges]);

  const focusId = active ?? hover;
  const linked = useMemo(() => {
    if (!focusId) return new Set<string>();
    const set = new Set<string>([focusId]);
    for (const e of analysis.graph.edges) {
      if (e.from === focusId || e.to === focusId) {
        set.add(e.from);
        set.add(e.to);
      }
    }
    return set;
  }, [focusId, analysis.graph.edges]);

  const visible = useMemo(() => {
    if (!kindFilter) return new Set(items.map((n) => n.id));
    const set = new Set<string>();
    for (const n of items) {
      if (n.kind !== kindFilter) continue;
      set.add(n.id);
      for (const e of analysis.graph.edges) {
        if (e.from === n.id) set.add(e.to);
        if (e.to === n.id) set.add(e.from);
      }
    }
    return set;
  }, [kindFilter, items, analysis.graph.edges]);

  const focus = items.find((n) => n.id === active) ?? null;
  const focusEdges = active
    ? analysis.graph.edges.filter((e) => e.from === active || e.to === active)
    : [];

  if (!items.length) {
    return (
      <p className="text-[13px] text-muted-foreground">
        No connections extracted from this testimony.
      </p>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-1.5">
        <button
          type="button"
          onClick={() => setKindFilter(null)}
          className={`rounded-full border px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.12em] ${
            !kindFilter
              ? "border-brand-navy bg-brand-navy text-white"
              : "border-border bg-card text-muted-foreground"
          }`}
        >
          All {items.length}
        </button>
        {KIND_ORDER.map((k) => {
          const n = items.filter((i) => i.kind === k).length;
          if (!n) return null;
          return (
            <button
              key={k}
              type="button"
              onClick={() => setKindFilter((cur) => (cur === k ? null : k))}
              className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.12em] ${
                kindFilter === k
                  ? "border-brand-navy bg-brand-navy text-white"
                  : "border-border bg-card text-muted-foreground hover:text-foreground"
              }`}
            >
              <span
                className={`h-2 w-2 rounded-full ${KIND_DOT[k]} ${kindFilter === k ? "bg-white" : ""}`}
              />
              {KIND_LABEL[k]} {n}
            </button>
          );
        })}
      </div>
      <div className="overflow-auto rounded-lg border border-slate-200 bg-white">
        <div
          className="relative min-h-[28rem] min-w-[40rem]"
          style={{ width, height: Math.max(height, 420) }}
        >
          <svg
            width={width}
            height={Math.max(height, 420)}
            className="absolute inset-0 pointer-events-none"
          >
            {analysis.graph.edges.map((e, i) => {
              const a = byId.get(e.from);
              const b = byId.get(e.to);
              if (!a || !b) return null;
              if (!visible.has(e.from) || !visible.has(e.to)) return null;
              const dim = focusId ? !linked.has(e.from) || !linked.has(e.to) : false;
              const on = focusId ? linked.has(e.from) && linked.has(e.to) : false;
              const conflict = /conflict|contradict|omit|den/i.test(e.label);
              const mx = (a.x + b.x) / 2;
              const lift = Math.abs(a.y - b.y) < 8 ? 40 : 24;
              const my = (a.y + b.y) / 2 - lift;
              return (
                <g key={`${e.from}-${e.to}-${i}`} opacity={dim ? 0.08 : 1}>
                  <path
                    d={`M ${a.x} ${a.y} Q ${mx} ${my} ${b.x} ${b.y}`}
                    fill="none"
                    stroke={conflict ? "#b42318" : on ? "#1e3a5f" : "#94a3b8"}
                    strokeWidth={on ? 2.4 : 1.5}
                  />
                </g>
              );
            })}
          </svg>
          {analysis.graph.edges.map((e, i) => {
            const a = byId.get(e.from);
            const b = byId.get(e.to);
            if (!a || !b || !e.cite) return null;
            if (!visible.has(e.from) || !visible.has(e.to)) return null;
            const dim = focusId ? !linked.has(e.from) || !linked.has(e.to) : false;
            if (dim) return null;
            const mx = (a.x + b.x) / 2;
            const lift = Math.abs(a.y - b.y) < 8 ? 40 : 24;
            const my = (a.y + b.y) / 2 - lift;
            return (
              <button
                key={`cite-${e.from}-${e.to}-${i}`}
                type="button"
                className="absolute z-20 -translate-x-1/2 -translate-y-full rounded bg-white/95 px-1.5 py-0.5 font-mono text-[10px] text-brand-navy shadow-sm ring-1 ring-border hover:bg-brand-navy hover:text-white"
                style={{ left: mx, top: my - 2 }}
                onClick={() => onCite(e.cite)}
              >
                {displayCite(e.cite)}
              </button>
            );
          })}
          {items.map((n) => {
            if (!visible.has(n.id)) return null;
            const dim = focusId ? !linked.has(n.id) : false;
            const on = active === n.id;
            const lines = wrapLabel(n.label);
            const links = degree.get(n.id) ?? 0;
            return (
              <button
                key={n.id}
                type="button"
                aria-pressed={on}
                className={`absolute z-10 flex flex-col justify-center rounded-xl border border-slate-200 border-l-[4px] px-3 py-2 text-left shadow-[0_1px_2px_rgba(15,23,42,0.06)] transition ${KIND_CARD[n.kind]} ${on ? "ring-2 ring-brand-navy shadow-md" : "hover:-translate-y-0.5 hover:shadow-md"} ${dim ? "opacity-15" : ""}`}
                style={{
                  left: n.x - CARD_W / 2,
                  top: n.y - CARD_H / 2,
                  width: CARD_W,
                  height: CARD_H,
                }}
                onClick={() => setActive((cur) => (cur === n.id ? null : n.id))}
                onMouseEnter={() => setHover(n.id)}
                onMouseLeave={() => setHover((h) => (h === n.id ? null : h))}
              >
                <span className="flex items-center justify-between gap-2">
                  <span className="text-[9px] font-semibold uppercase tracking-[0.14em] text-slate-500">
                    {KIND_LABEL[n.kind]}
                  </span>
                  {links ? (
                    <span className="rounded-full bg-slate-100 px-1.5 py-px text-[10px] font-semibold tabular-nums text-slate-600">
                      {links}
                    </span>
                  ) : null}
                </span>
                <span className="mt-0.5 flex flex-col text-[13px] font-semibold leading-snug text-slate-900">
                  {lines.map((line, i) => (
                    <span key={`${n.id}-${i}`}>{line}</span>
                  ))}
                </span>
              </button>
            );
          })}
        </div>
      </div>
      {focus ? (
        <div className="rounded-xl border border-border bg-card px-3.5 py-3">
          <p className="text-[13px] font-semibold text-foreground">
            {focus.label}
            <span className="ml-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
              {KIND_LABEL[focus.kind]} · {focusEdges.length} link
              {focusEdges.length === 1 ? "" : "s"}
            </span>
          </p>
          {focusEdges.length ? (
            <ul className="mt-2 space-y-1.5">
              {focusEdges.map((e, i) => {
                const otherId = e.from === focus.id ? e.to : e.from;
                const other = byId.get(otherId);
                return (
                  <li
                    key={`${e.from}-${e.to}-${i}`}
                    className="flex flex-wrap items-center gap-2 text-[12.5px] text-muted-foreground"
                  >
                    <span className="font-medium text-foreground/85">{e.label}</span>
                    <button
                      type="button"
                      className="text-foreground hover:underline"
                      onClick={() => other && setActive(other.id)}
                    >
                      {other?.label ?? otherId}
                    </button>
                    {e.cite ? (
                      <button
                        type="button"
                        className="font-mono text-[11px] text-brand-navy hover:underline"
                        onClick={() => onCite(e.cite)}
                      >
                        {displayCite(e.cite)}
                      </button>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          ) : (
            <p className="mt-1 text-[12.5px] text-muted-foreground">No links on this node.</p>
          )}
        </div>
      ) : (
        <p className="text-[11.5px] text-muted-foreground">
          Filter by type, hover to preview links, click a card to pin. Click a page:line to open
          testimony.
        </p>
      )}
    </div>
  );
}
