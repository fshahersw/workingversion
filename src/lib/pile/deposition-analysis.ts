import { formatCite, type TranscriptLine, type TranscriptParse } from "./transcript.ts";

export type DepFinding = {
  id: string;
  title: string;
  summary: string;
  quote: string;
  cite: string;
  tags: string[];
  value: "helpful" | "high" | "impeach" | "neutral";
  use: "" | "open" | "impeach" | "notice" | "auth" | "gap";
};

export type DepChronologyEvent = {
  id: string;
  date: string;
  title: string;
  summary: string;
  quote: string;
  cite: string;
};

export type DepExhibit = {
  id: string;
  name: string;
  summary: string;
  quote: string;
  cite: string;
};

export type DepWitnessCard = {
  id: string;
  name: string;
  role: string;
  fileName: string;
  summary: string;
  quote: string;
  cite: string;
};

export type DepSide = { witness: string; quote: string; cite: string; fileName: string };

export type DepContradiction = {
  id: string;
  title: string;
  summary: string;
  a: DepSide;
  b: DepSide;
  tags: string[];
};

export type DepGraphNode = {
  id: string;
  label: string;
  kind: "person" | "org" | "doc" | "theme" | "event";
};

export type DepGraphEdge = { from: string; to: string; label: string; cite: string };

export type DepAnalysis = {
  role: string;
  summary: string;
  profile: DepFinding[];
  admissions: DepFinding[];
  impeachment: DepFinding[];
  themes: DepFinding[];
  objections: DepFinding[];
  chronology: DepChronologyEvent[];
  exhibits: DepExhibit[];
  witnesses: DepWitnessCard[];
  contradictions: DepContradiction[];
  graph: { nodes: DepGraphNode[]; edges: DepGraphEdge[] };
  dropped: number;
};

/** Compact extracted findings for a synthesis pass. */
export function compactDepAnalysis(a: DepAnalysis): string {
  const slim = {
    role: a.role,
    summary: a.summary,
    admissions: a.admissions.slice(0, 48).map((f) => ({
      title: f.title,
      quote: f.quote,
      cite: f.cite,
      use: f.use,
      value: f.value,
    })),
    impeachment: a.impeachment.slice(0, 32).map((f) => ({
      title: f.title,
      quote: f.quote,
      cite: f.cite,
    })),
    themes: a.themes.slice(0, 24).map((f) => ({ title: f.title, quote: f.quote, cite: f.cite })),
    chronology: a.chronology.slice(0, 40).map((e) => ({ date: e.date, title: e.title, cite: e.cite })),
    exhibits: a.exhibits.slice(0, 32).map((e) => ({ name: e.name, cite: e.cite, summary: e.summary })),
    witnesses: a.witnesses.slice(0, 16).map((w) => ({ name: w.name, role: w.role, fileName: w.fileName, cite: w.cite })),
    contradictions: a.contradictions.slice(0, 24).map((c) => ({
      title: c.title,
      a: { witness: c.a.witness, cite: c.a.cite, fileName: c.a.fileName, quote: c.a.quote },
      b: { witness: c.b.witness, cite: c.b.cite, fileName: c.b.fileName, quote: c.b.quote },
    })),
    graph: {
      nodes: a.graph.nodes.slice(0, 48),
      edges: a.graph.edges.slice(0, 64),
    },
  };
  return JSON.stringify(slim);
}

export const EMPTY_ANALYSIS: DepAnalysis = {
  role: "",
  summary: "",
  profile: [],
  admissions: [],
  impeachment: [],
  themes: [],
  objections: [],
  chronology: [],
  exhibits: [],
  witnesses: [],
  contradictions: [],
  graph: { nodes: [], edges: [] },
  dropped: 0,
};

export function normalizeQuote(s: string): string {
  return (s ?? "")
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/[.,;:!?]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

export function quoteInTranscript(quote: string, lines: TranscriptLine[]): boolean {
  return snapQuote(quote, lines) != null;
}

export function snapQuote(quote: string, lines: TranscriptLine[]): { quote: string; cite: string } | null {
  const q = normalizeQuote(quote).replace(/^["']+|["']+$/g, "");
  if (q.length < 10 || !lines.length) return null;

  const parts: { line: TranscriptLine; start: number; end: number }[] = [];
  const chunks: string[] = [];
  let cursor = 0;
  for (const line of lines) {
    const n = normalizeQuote(line.text);
    if (!n) continue;
    if (chunks.length) cursor += 1;
    parts.push({ line, start: cursor, end: cursor + n.length });
    chunks.push(n);
    cursor += n.length;
  }
  const hay = chunks.join(" ");

  let idx = hay.indexOf(q);
  let matched = q;
  if (idx < 0 && q.length > 28) {
    const head = q.slice(0, 72);
    const tail = q.slice(-72);
    idx = hay.indexOf(head);
    if (idx >= 0) matched = head;
    else {
      idx = hay.indexOf(tail);
      if (idx >= 0) matched = tail;
    }
  }
  if (idx < 0) {
    const words = q.split(" ").filter((w) => w.length > 1);
    outer: for (let n = Math.min(12, words.length); n >= 5; n--) {
      for (let i = 0; i <= words.length - n; i++) {
        const win = words.slice(i, i + n).join(" ");
        if (win.length < 16) continue;
        const at = hay.indexOf(win);
        if (at >= 0) {
          idx = at;
          matched = win;
          break outer;
        }
      }
    }
  }
  if (idx < 0) return null;
  const end = idx + matched.length;
  const covered = parts.filter((p) => p.end > idx && p.start < end);
  if (!covered.length) return null;
  const first = covered[0]!.line;
  const last = covered[covered.length - 1]!.line;
  const original = covered
    .map((c) => c.line.text)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
  return {
    quote: (original.length >= 12 && original.length <= 360 ? original : quote.replace(/^["“”']+|["“”']+$/g, "").trim()).slice(
      0,
      360,
    ),
    cite: formatCite(first.page, first.line, last.page, last.line),
  };
}

export function parseCiteStart(cite: string): { page: number; line: number } | null {
  const m = (cite ?? "").match(/(\d{1,4})\s*:\s*(\d{1,2})/);
  if (!m) return null;
  return { page: Number(m[1]), line: Number(m[2]) };
}

export function displayCite(cite: string): string {
  const range = (cite ?? "").match(/(\d{1,4}\s*:\s*\d{1,2})(?:\s*-\s*(\d{1,4}\s*:\s*\d{1,2}))?/);
  if (!range) return cite.trim();
  const start = range[1]!.replace(/\s+/g, "");
  const end = range[2]?.replace(/\s+/g, "");
  return end && end !== start ? `${start}-${end}` : start;
}

export function extractCaptionMeta(caption: string): { mdl: string | null; taken: string | null } {
  const mdl = caption.match(/\bMDL\s*[:#]?\s*(\d{2,5})\b/i);
  const taken =
    caption.match(
      /(?:taken|deposed|dated|date of deposition)[:\s]+([A-Za-z]+\s+\d{1,2},\s+\d{4}|\d{1,2}\/\d{1,2}\/\d{2,4}|\d{4}-\d{2}-\d{2})/i,
    ) ?? caption.match(/\b([A-Za-z]+\s+\d{1,2},\s+\d{4})\b/);
  return { mdl: mdl ? `MDL ${mdl[1]}` : null, taken: taken?.[1] ?? null };
}

function asString(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

function asTags(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.map((t) => asString(t)).filter(Boolean).slice(0, 6);
}

function asValue(v: unknown): DepFinding["value"] {
  const s = asString(v).toLowerCase();
  if (s === "high" || s === "high value") return "high";
  if (s === "impeach" || s === "impeachment") return "impeach";
  if (s === "neutral") return "neutral";
  return "helpful";
}

function asUse(v: unknown): DepFinding["use"] {
  const s = asString(v).toLowerCase();
  if (s === "open" || s === "impeach" || s === "notice" || s === "auth" || s === "gap") return s;
  return "";
}

function extractJson(text: string): Record<string, unknown> | null {
  const raw = text ?? "";
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fenced?.[1] ?? raw;
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const parsed = JSON.parse(body.slice(start, end + 1)) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function findingFrom(raw: unknown, i: number, prefix: string): DepFinding | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const title = asString(o.title) || asString(o.claim);
  const quote = asString(o.quote);
  if (!title && !quote) return null;
  return {
    id: `${prefix}-${i}`,
    title: title || "Finding",
    summary: asString(o.summary),
    quote,
    cite: asString(o.cite),
    tags: asTags(o.tags),
    value: asValue(o.value),
    use: asUse(o.use),
  };
}

function eventFrom(raw: unknown, i: number): DepChronologyEvent | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const title = asString(o.title);
  if (!title) return null;
  return {
    id: `chrono-${i}`,
    date: asString(o.date) || "Undated",
    title,
    summary: asString(o.summary),
    quote: asString(o.quote),
    cite: asString(o.cite),
  };
}

function sideFrom(raw: unknown): DepSide {
  if (!raw || typeof raw !== "object") return { witness: "", quote: "", cite: "", fileName: "" };
  const o = raw as Record<string, unknown>;
  return {
    witness: asString(o.witness),
    quote: asString(o.quote),
    cite: asString(o.cite),
    fileName: asString(o.fileName) || asString(o.file),
  };
}

function witnessFrom(raw: unknown, i: number): DepWitnessCard | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const name = asString(o.name);
  if (!name) return null;
  return {
    id: `wit-${i}`,
    name,
    role: asString(o.role),
    fileName: asString(o.fileName) || asString(o.file),
    summary: asString(o.summary),
    quote: asString(o.quote),
    cite: asString(o.cite),
  };
}

function contradictionFrom(raw: unknown, i: number): DepContradiction | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const title = asString(o.title);
  if (!title) return null;
  return {
    id: `con-${i}`,
    title,
    summary: asString(o.summary),
    a: sideFrom(o.a),
    b: sideFrom(o.b),
    tags: asTags(o.tags),
  };
}

function nodeFrom(raw: unknown, i: number): DepGraphNode | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const label = asString(o.label) || asString(o.name);
  if (!label) return null;
  const kindRaw = asString(o.kind);
  const kind: DepGraphNode["kind"] =
    kindRaw === "org" || kindRaw === "doc" || kindRaw === "theme" || kindRaw === "event" ? kindRaw : "person";
  return { id: asString(o.id) || `n-${i}-${label.toLowerCase().replace(/\s+/g, "-").slice(0, 24)}`, label, kind };
}

function edgeFrom(raw: unknown): DepGraphEdge | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const from = asString(o.from);
  const to = asString(o.to);
  if (!from || !to) return null;
  return { from, to, label: asString(o.label) || "related", cite: asString(o.cite) };
}

function exhibitFrom(raw: unknown, i: number): DepExhibit | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const name = asString(o.name) || asString(o.title);
  if (!name) return null;
  return {
    id: `ex-${i}`,
    name,
    summary: asString(o.summary),
    quote: asString(o.quote),
    cite: asString(o.cite),
  };
}

function list(raw: unknown): unknown[] {
  return Array.isArray(raw) ? raw : [];
}

export function parseDepAnalysis(text: string): DepAnalysis {
  const obj = extractJson(text);
  if (!obj) {
    const fallback = (text ?? "").trim();
    return { ...EMPTY_ANALYSIS, summary: fallback.slice(0, 8000) };
  }
  return {
    role: asString(obj.role),
    summary: asString(obj.summary),
    profile: list(obj.profile).map((x, i) => findingFrom(x, i, "profile")).filter((x): x is DepFinding => !!x),
    admissions: list(obj.admissions).map((x, i) => findingFrom(x, i, "adm")).filter((x): x is DepFinding => !!x),
    impeachment: list(obj.impeachment).map((x, i) => findingFrom(x, i, "imp")).filter((x): x is DepFinding => !!x),
    themes: list(obj.themes).map((x, i) => findingFrom(x, i, "theme")).filter((x): x is DepFinding => !!x),
    objections: list(obj.objections).map((x, i) => findingFrom(x, i, "obj")).filter((x): x is DepFinding => !!x),
    chronology: list(obj.chronology).map((x, i) => eventFrom(x, i)).filter((x): x is DepChronologyEvent => !!x),
    exhibits: list(obj.exhibits).map((x, i) => exhibitFrom(x, i)).filter((x): x is DepExhibit => !!x),
    witnesses: list(obj.witnesses).map((x, i) => witnessFrom(x, i)).filter((x): x is DepWitnessCard => !!x),
    contradictions: list(obj.contradictions).map((x, i) => contradictionFrom(x, i)).filter((x): x is DepContradiction => !!x),
    graph: (() => {
      const g = obj.graph && typeof obj.graph === "object" ? (obj.graph as Record<string, unknown>) : {};
      return {
        nodes: list(g.nodes).map((x, i) => nodeFrom(x, i)).filter((x): x is DepGraphNode => !!x),
        edges: list(g.edges).map((x) => edgeFrom(x)).filter((x): x is DepGraphEdge => !!x),
      };
    })(),
    dropped: 0,
  };
}

function keepQuoted<T extends { quote: string; cite: string }>(
  items: T[],
  lines: TranscriptLine[],
): { kept: T[]; dropped: number } {
  const kept: T[] = [];
  let dropped = 0;
  for (const item of items) {
    if (!item.quote) {
      kept.push({ ...item, cite: displayCite(item.cite) });
      continue;
    }
    const snapped = snapQuote(item.quote, lines);
    if (snapped) kept.push({ ...item, quote: snapped.quote, cite: snapped.cite });
    else dropped += 1;
  }
  return { kept, dropped };
}

export function mergeDepAnalysis(base: DepAnalysis, next: DepAnalysis): DepAnalysis {
  // Dedupe on cite + normalized quote, not title: the synth/cross passes often
  // rephrase a finding's title while quoting the same testimony, and title-based
  // keys let those duplicates back in.
  const uniq = <T extends { quote: string; cite: string }>(a: T[], b: T[]) => {
    const out = [...a];
    for (const item of b) {
      const key = `${displayCite(item.cite)}|${normalizeQuote(item.quote)}`;
      if (key === "|") continue; // no quote and no cite — always keep
      if (out.some((x) => `${displayCite(x.cite)}|${normalizeQuote(x.quote)}` === key)) continue;
      out.push(item);
    }
    return out;
  };
  const contradictionKey = (c: DepContradiction) => {
    const sides = [normalizeQuote(c.a.quote), normalizeQuote(c.b.quote)].sort();
    return sides.join("|") || c.title.toLowerCase();
  };
  const contradictions = [...base.contradictions];
  for (const c of next.contradictions) {
    const key = contradictionKey(c);
    if (key && contradictions.some((x) => contradictionKey(x) === key)) continue;
    contradictions.push(c);
  }
  const normName = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();
  // Each pass parses ids from a fresh index base (adm-0, theme-0, …), so after
  // merging multiple windows the same id recurs across items. Re-key every list
  // to a unique per-category id so React keys — and the working set, which is
  // keyed by finding id — never collide.
  const reindex = <T extends { id: string }>(arr: T[], prefix: string): T[] =>
    arr.map((x, i) => ({ ...x, id: `${prefix}-${i}` }));
  return {
    role: next.role || base.role,
    summary: next.summary || base.summary,
    profile: reindex(uniq(base.profile, next.profile), "pf"),
    admissions: reindex(uniq(base.admissions, next.admissions), "adm"),
    impeachment: reindex(uniq(base.impeachment, next.impeachment), "imp"),
    themes: reindex(uniq(base.themes, next.themes), "theme"),
    objections: reindex(uniq(base.objections, next.objections), "obj"),
    chronology: reindex(uniq(base.chronology, next.chronology), "chrono"),
    exhibits: reindex(
      [
        ...base.exhibits,
        ...next.exhibits.filter(
          (e) => !base.exhibits.some((x) => normName(x.name) === normName(e.name) && displayCite(x.cite) === displayCite(e.cite)),
        ),
      ],
      "ex",
    ),
    witnesses: reindex(
      [
        ...base.witnesses,
        ...next.witnesses.filter((w) => !base.witnesses.some((x) => normName(x.name) === normName(w.name))),
      ],
      "wit",
    ),
    contradictions: reindex(contradictions, "con"),
    graph: {
      nodes: [...base.graph.nodes, ...next.graph.nodes.filter((n) => !base.graph.nodes.some((x) => x.id === n.id || x.label === n.label))],
      edges: [...base.graph.edges, ...next.graph.edges.filter((e) => !base.graph.edges.some((x) => x.from === e.from && x.to === e.to && x.label === e.label))],
    },
    dropped: base.dropped + next.dropped,
  };
}

export function verifyDepAnalysis(analysis: DepAnalysis, parsed: TranscriptParse | TranscriptParse[]): DepAnalysis {
  const lines = Array.isArray(parsed) ? parsed.flatMap((p) => p.lines) : parsed.lines;
  const profile = keepQuoted(analysis.profile, lines);
  const admissions = keepQuoted(analysis.admissions, lines);
  const impeachment = keepQuoted(analysis.impeachment, lines);
  const themes = keepQuoted(analysis.themes, lines);
  const objections = keepQuoted(analysis.objections, lines);
  const chronology = keepQuoted(analysis.chronology, lines);
  const exhibits = keepQuoted(analysis.exhibits, lines);
  const witnesses = keepQuoted(analysis.witnesses, lines);
  let extraDrop = 0;
  const contradictions = analysis.contradictions.map((c) => {
    const a = c.a.quote ? snapQuote(c.a.quote, lines) : null;
    const b = c.b.quote ? snapQuote(c.b.quote, lines) : null;
    if (c.a.quote && !a) extraDrop += 1;
    if (c.b.quote && !b) extraDrop += 1;
    return {
      ...c,
      a: a ? { ...c.a, quote: a.quote, cite: a.cite } : c.a,
      b: b ? { ...c.b, quote: b.quote, cite: b.cite } : c.b,
    };
  });
  return {
    ...analysis,
    profile: profile.kept,
    admissions: admissions.kept,
    impeachment: impeachment.kept,
    themes: themes.kept,
    objections: objections.kept,
    chronology: chronology.kept,
    exhibits: exhibits.kept,
    witnesses: witnesses.kept,
    contradictions,
    dropped:
      profile.dropped +
      admissions.dropped +
      impeachment.dropped +
      themes.dropped +
      objections.dropped +
      chronology.dropped +
      exhibits.dropped +
      witnesses.dropped +
      extraDrop,
  };
}

export function lineMatchesSpeaker(
  line: TranscriptLine,
  filter: "any" | "question" | "answer" | "objection",
): boolean {
  if (filter === "any") return true;
  if (filter === "question") return line.speaker === "Q";
  if (filter === "answer") return line.speaker === "A" || line.speaker === "WITNESS";
  return /object/i.test(line.text) || line.speaker === "COURT";
}

export function lineMatchesQuery(line: TranscriptLine, query: string, regex: boolean): boolean {
  const q = query.trim();
  if (!q) return true;
  const hay = `${line.speakerLabel} ${line.text}`;
  if (regex) {
    try {
      return new RegExp(q, "i").test(hay);
    } catch {
      return hay.toLowerCase().includes(q.toLowerCase());
    }
  }
  return hay.toLowerCase().includes(q.toLowerCase());
}

export type DepInsights = {
  high: number;
  notice: number;
  impeach: number;
  gaps: number;
  conflicts: number;
  exhibits: number;
  people: number;
  edges: number;
};

export function depInsights(analysis: DepAnalysis | null): DepInsights {
  const empty: DepInsights = {
    high: 0,
    notice: 0,
    impeach: 0,
    gaps: 0,
    conflicts: 0,
    exhibits: 0,
    people: 0,
    edges: 0,
  };
  if (!analysis) return empty;
  const findings = [
    ...analysis.admissions,
    ...analysis.impeachment,
    ...analysis.themes,
    ...analysis.objections,
  ];
  return {
    high: findings.filter((f) => f.value === "high").length,
    notice: findings.filter((f) => f.use === "notice" || f.tags.some((t) => /notice|knowledge/i.test(t))).length,
    impeach: analysis.impeachment.length + findings.filter((f) => f.use === "impeach").length,
    gaps: findings.filter((f) => f.use === "gap").length,
    conflicts: analysis.contradictions.length,
    exhibits: analysis.exhibits.length,
    people: analysis.graph.nodes.filter((n) => n.kind === "person").length || analysis.witnesses.length,
    edges: analysis.graph.edges.length,
  };
}

export function analysisToMarkdown(witness: string | null, analysis: DepAnalysis): string {
  const lines: string[] = [];
  lines.push(`# ${witness || "Deposition"}`);
  if (analysis.role) lines.push(`_${analysis.role}_`);
  if (analysis.summary) lines.push("", analysis.summary);
  const section = (title: string, items: { title: string; quote?: string; cite?: string; summary?: string }[]) => {
    if (!items.length) return;
    lines.push("", `## ${title}`);
    for (const item of items) {
      lines.push(`- **${item.title}**${item.cite ? ` (${item.cite})` : ""}`);
      if (item.summary) lines.push(`  ${item.summary}`);
      if (item.quote) lines.push(`  > ${item.quote}`);
    }
  };
  section("Witness profile", analysis.profile);
  section("Admissions", analysis.admissions);
  section("Impeachment", analysis.impeachment);
  section(
    "Chronology",
    analysis.chronology.map((e) => ({ title: `${e.date} — ${e.title}`, quote: e.quote, cite: e.cite, summary: e.summary })),
  );
  section(
    "Exhibits",
    analysis.exhibits.map((e) => ({ title: e.name, quote: e.quote, cite: e.cite, summary: e.summary })),
  );
  section("Themes", analysis.themes);
  section(
    "Witnesses",
    analysis.witnesses.map((w) => ({ title: w.name, quote: w.quote, cite: w.cite, summary: w.summary })),
  );
  section(
    "Conflicts",
    analysis.contradictions.map((c) => ({
      title: c.title,
      cite: [c.a.cite, c.b.cite].filter(Boolean).join(" / "),
      summary: c.summary,
      quote: [c.a.quote && `${c.a.witness}: ${c.a.quote}`, c.b.quote && `${c.b.witness}: ${c.b.quote}`]
        .filter(Boolean)
        .join(" | "),
    })),
  );
  if (analysis.graph.nodes.length) {
    lines.push("", "## Connections");
    for (const n of analysis.graph.nodes) lines.push(`- ${n.kind}: **${n.label}**`);
    for (const e of analysis.graph.edges) {
      const from = analysis.graph.nodes.find((n) => n.id === e.from)?.label || e.from;
      const to = analysis.graph.nodes.find((n) => n.id === e.to)?.label || e.to;
      lines.push(`- ${from} — ${e.label} → ${to}${e.cite ? ` (${e.cite})` : ""}`);
    }
  }
  return lines.join("\n");
}
