import { formatCite, type TranscriptLine, type TranscriptParse } from "./transcript.ts";
import { batchEvidence, type EvidencePage } from "./deposition-context.ts";

export type DepEvidence = {
  fileName?: string;
  /** A quote match is provenance, not a legal or semantic validation of the claim. */
  evidenceStatus?: "source_matched" | "needs_review";
};

export type DepFinding = DepEvidence & {
  id: string;
  title: string;
  summary: string;
  quote: string;
  cite: string;
  tags: string[];
  value: "helpful" | "high" | "impeach" | "neutral";
  use: "" | "open" | "impeach" | "notice" | "auth" | "gap";
};

export type DepChronologyEvent = DepEvidence & {
  id: string;
  date: string;
  title: string;
  summary: string;
  quote: string;
  cite: string;
};

export type DepExhibit = DepEvidence & {
  id: string;
  name: string;
  summary: string;
  quote: string;
  cite: string;
};

export type DepWitnessCard = DepEvidence & {
  id: string;
  name: string;
  role: string;
  fileName: string;
  summary: string;
  quote: string;
  cite: string;
};

export type DepSide = DepEvidence & {
  witness: string;
  quote: string;
  cite: string;
  fileName: string;
};

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

export type DepGraphEdge = DepEvidence & {
  from: string;
  to: string;
  label: string;
  cite: string;
  quote?: string;
};

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

/** Lossless serialization; batch with depositionFindingBatches before sending to a model. */
export function compactDepAnalysis(a: DepAnalysis): string {
  return JSON.stringify(a);
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

export function snapQuote(
  quote: string,
  lines: TranscriptLine[],
): { quote: string; cite: string } | null {
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
    quote: (original.length >= 12 && original.length <= 360
      ? original
      : quote.replace(/^["“”']+|["“”']+$/g, "").trim()
    ).slice(0, 360),
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

function evidenceFrom(o: Record<string, unknown>): DepEvidence {
  const fileName = asString(o.fileName) || asString(o.file);
  return fileName ? { fileName } : {};
}

function asTags(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v
    .map((t) => asString(t))
    .filter(Boolean)
    .slice(0, 6);
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
    ...evidenceFrom(o),
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
    ...evidenceFrom(o),
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
    kindRaw === "org" || kindRaw === "doc" || kindRaw === "theme" || kindRaw === "event"
      ? kindRaw
      : "person";
  return {
    id: asString(o.id) || `n-${i}-${label.toLowerCase().replace(/\s+/g, "-").slice(0, 24)}`,
    label,
    kind,
  };
}

function edgeFrom(raw: unknown): DepGraphEdge | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const from = asString(o.from);
  const to = asString(o.to);
  if (!from || !to) return null;
  return {
    from,
    to,
    label: asString(o.label) || "related",
    cite: asString(o.cite),
    ...(asString(o.quote) ? { quote: asString(o.quote) } : {}),
    ...evidenceFrom(o),
  };
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
    ...evidenceFrom(o),
  };
}

function list(raw: unknown): unknown[] {
  return Array.isArray(raw) ? raw : [];
}

export function parseDepAnalysis(text: string, strict = false): DepAnalysis {
  const obj = extractJson(text);
  if (!obj) {
    if (strict)
      throw new Error(
        "The analysis response was incomplete or malformed. The completed evidence windows are retained; retry analysis.",
      );
    const fallback = (text ?? "").trim();
    return { ...EMPTY_ANALYSIS, summary: fallback.slice(0, 8000) };
  }
  return {
    role: asString(obj.role),
    summary: asString(obj.summary),
    profile: list(obj.profile)
      .map((x, i) => findingFrom(x, i, "profile"))
      .filter((x): x is DepFinding => !!x),
    admissions: list(obj.admissions)
      .map((x, i) => findingFrom(x, i, "adm"))
      .filter((x): x is DepFinding => !!x),
    impeachment: list(obj.impeachment)
      .map((x, i) => findingFrom(x, i, "imp"))
      .filter((x): x is DepFinding => !!x),
    themes: list(obj.themes)
      .map((x, i) => findingFrom(x, i, "theme"))
      .filter((x): x is DepFinding => !!x),
    objections: list(obj.objections)
      .map((x, i) => findingFrom(x, i, "obj"))
      .filter((x): x is DepFinding => !!x),
    chronology: list(obj.chronology)
      .map((x, i) => eventFrom(x, i))
      .filter((x): x is DepChronologyEvent => !!x),
    exhibits: list(obj.exhibits)
      .map((x, i) => exhibitFrom(x, i))
      .filter((x): x is DepExhibit => !!x),
    witnesses: list(obj.witnesses)
      .map((x, i) => witnessFrom(x, i))
      .filter((x): x is DepWitnessCard => !!x),
    contradictions: list(obj.contradictions)
      .map((x, i) => contradictionFrom(x, i))
      .filter((x): x is DepContradiction => !!x),
    graph: (() => {
      const g =
        obj.graph && typeof obj.graph === "object" ? (obj.graph as Record<string, unknown>) : {};
      return {
        nodes: list(g.nodes)
          .map((x, i) => nodeFrom(x, i))
          .filter((x): x is DepGraphNode => !!x),
        edges: list(g.edges)
          .map((x) => edgeFrom(x))
          .filter((x): x is DepGraphEdge => !!x),
      };
    })(),
    dropped: 0,
  };
}

type EvidenceIndexPart = { line: TranscriptLine; start: number; end: number };
const evidenceIndexes = new WeakMap<TranscriptParse, { hay: string; parts: EvidenceIndexPart[] }>();

/** Parsed transcripts are replaced after OCR; reuse their immutable text index across findings. */
function evidenceIndex(transcript: TranscriptParse) {
  const cached = evidenceIndexes.get(transcript);
  if (cached) return cached;
  const parts: EvidenceIndexPart[] = [];
  const chunks: string[] = [];
  let length = 0;
  for (const line of transcript.lines) {
    const text = normalizeQuote(line.text);
    if (!text) continue;
    if (chunks.length) length++;
    parts.push({ line, start: length, end: length + text.length });
    chunks.push(text);
    length += text.length;
  }
  const index = { hay: chunks.join(" "), parts };
  evidenceIndexes.set(transcript, index);
  return index;
}

/** Locate only the lines intersecting the matched quotation, without rescanning every page. */
function intersectingLines(parts: EvidenceIndexPart[], start: number, end: number) {
  let low = 0,
    high = parts.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (parts[mid]!.end <= start) low = mid + 1;
    else high = mid;
  }
  const covered: EvidenceIndexPart[] = [];
  for (let i = low; i < parts.length && parts[i]!.start < end; i++) covered.push(parts[i]!);
  return covered;
}

/** Match the complete normalized quotation within ONE transcript. No fuzzy fragments. */
export function matchDepEvidence(
  item: { quote?: string; cite: string; fileName?: string },
  transcripts: TranscriptParse[],
): { quote: string; cite: string; fileName: string; evidenceStatus: "source_matched" } | null {
  const quote = (item.quote ?? "").replace(/^["“”']+|["“”']+$/g, "").trim();
  const q = normalizeQuote(quote);
  if (q.length < 10) return null;
  const candidates = item.fileName
    ? transcripts.filter((t) => t.fileName === item.fileName)
    : transcripts;
  // Duplicate filenames cannot safely identify a source.
  if (item.fileName && candidates.length !== 1) return null;
  const matches: {
    quote: string;
    cite: string;
    fileName: string;
    evidenceStatus: "source_matched";
  }[] = [];
  for (const t of candidates) {
    const { parts, hay } = evidenceIndex(t);
    const occurrences: (typeof parts)[] = [];
    let at = hay.indexOf(q);
    while (at >= 0) {
      // Avoid matching a substring inside a word.
      if (
        (!at || !/[\p{L}\p{N}]/u.test(hay[at - 1]!)) &&
        (at + q.length === hay.length || !/[\p{L}\p{N}]/u.test(hay[at + q.length]!))
      ) {
        occurrences.push(intersectingLines(parts, at, at + q.length));
      }
      at = hay.indexOf(q, at + 1);
    }
    const requested = parseCiteStart(item.cite);
    const cited = requested
      ? occurrences.filter((lines) =>
          lines.some((p) => p.line.page === requested.page && p.line.line === requested.line),
        )
      : [];
    const covered =
      cited.length === 1 ? cited[0] : occurrences.length === 1 ? occurrences[0] : undefined;
    if (!covered?.length) continue;
    const first = covered[0]!.line,
      last = covered[covered.length - 1]!.line;
    matches.push({
      quote,
      cite: t.citeReady ? formatCite(first.page, first.line, last.page, last.line) : "",
      fileName: t.fileName,
      evidenceStatus: "source_matched",
    });
  }
  // Common testimony in several files is ambiguous without a filename.
  return matches.length === 1 ? matches[0]! : null;
}

/** Every finding reaches synthesis; each JSON record stays intact within its batch. */
export function depositionFindingBatches(analysis: DepAnalysis): EvidencePage[][] {
  const pages: EvidencePage[] = [];
  const add = (category: string, value: unknown, fileName = "Extracted findings") => {
    const text = JSON.stringify({ category, value });
    if (text.length > 24_000)
      throw new Error(
        "An extracted finding is too large to synthesize safely. Covering results are retained.",
      );
    pages.push({ fileName, page: pages.length + 1, text });
  };
  for (const category of [
    "profile",
    "admissions",
    "impeachment",
    "themes",
    "objections",
    "chronology",
    "exhibits",
    "witnesses",
  ] as const) {
    for (const finding of analysis[category]) add(category, finding, finding.fileName);
  }
  for (const conflict of analysis.contradictions) add("potential_conflict", conflict);
  const nodes = new Map(analysis.graph.nodes.map((n) => [n.id, n]));
  for (const edge of analysis.graph.edges) {
    if (edge.evidenceStatus === "source_matched")
      add(
        "relationship",
        { ...edge, from: nodes.get(edge.from)?.label, to: nodes.get(edge.to)?.label },
        edge.fileName,
      );
  }
  if (!pages.length && analysis.summary) add("summary", analysis.summary);
  return batchEvidence(pages);
}

function keepQuoted<T extends { quote: string; cite: string; fileName?: string }>(
  items: T[],
  transcripts: TranscriptParse[],
): { kept: T[]; dropped: number } {
  const kept: T[] = [];
  let dropped = 0;
  for (const item of items) {
    if (!item.quote) {
      kept.push({ ...item, cite: "", evidenceStatus: "needs_review" });
      continue;
    }
    const snapped = matchDepEvidence(item, transcripts);
    if (snapped) kept.push({ ...item, ...snapped });
    else dropped += 1;
  }
  return { kept, dropped };
}

export function mergeDepAnalysis(base: DepAnalysis, next: DepAnalysis): DepAnalysis {
  // Dedupe on cite + normalized quote, not title: the synth/cross passes often
  // rephrase a finding's title while quoting the same testimony, and title-based
  // keys let those duplicates back in.
  const uniq = <T extends { quote: string; cite: string; fileName?: string }>(a: T[], b: T[]) => {
    const out = [...a];
    for (const item of b) {
      const key = `${item.fileName ?? ""}|${displayCite(item.cite)}|${normalizeQuote(item.quote)}`;
      if (!item.cite && !item.quote) {
        out.push(item); // summary-only synth/cross findings have no stable dedupe key
        continue;
      }
      if (
        out.some(
          (x) => `${x.fileName ?? ""}|${displayCite(x.cite)}|${normalizeQuote(x.quote)}` === key,
        )
      )
        continue;
      out.push(item);
    }
    return out;
  };
  const contradictionKey = (c: DepContradiction) => {
    const sides = [c.a, c.b]
      .map((s) => `${s.fileName}|${displayCite(s.cite)}|${normalizeQuote(s.quote)}`)
      .sort();
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
          (e) =>
            !base.exhibits.some(
              (x) =>
                normName(x.name) === normName(e.name) &&
                x.fileName === e.fileName &&
                displayCite(x.cite) === displayCite(e.cite),
            ),
        ),
      ],
      "ex",
    ),
    witnesses: reindex(
      [
        ...base.witnesses,
        ...next.witnesses.filter(
          (w) =>
            !base.witnesses.some(
              (x) => normName(x.name) === normName(w.name) && x.fileName === w.fileName,
            ),
        ),
      ],
      "wit",
    ),
    contradictions: reindex(contradictions, "con"),
    graph: mergeDepGraphs(base.graph, next.graph),
    dropped: base.dropped + next.dropped,
  };
}

/** Model IDs are local to a response; remap both endpoints before merging. */
export function mergeDepGraphs(...graphs: DepAnalysis["graph"][]): DepAnalysis["graph"] {
  const nodes = new Map<string, DepGraphNode>();
  const edges = new Map<string, DepGraphEdge>();
  for (const graph of graphs) {
    const ids = new Map<string, string>();
    for (const n of graph.nodes) {
      const id = `${n.kind}:${n.label.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim()}`;
      // Reject ambiguous IDs inside one response instead of connecting to an arbitrary entity.
      ids.set(n.id, ids.has(n.id) && ids.get(n.id) !== id ? "" : id);
      if (!nodes.has(id)) nodes.set(id, { ...n, id });
    }
    for (const e of graph.edges) {
      const from = ids.get(e.from),
        to = ids.get(e.to);
      if (!from || !to || from === to) continue;
      const key = JSON.stringify([
        from,
        to,
        e.label.toLowerCase(),
        e.fileName,
        displayCite(e.cite),
        normalizeQuote(e.quote ?? ""),
      ]);
      edges.set(key, { ...e, from, to });
    }
  }
  return { nodes: [...nodes.values()], edges: [...edges.values()] };
}

export function verifyDepAnalysis(
  analysis: DepAnalysis,
  parsed: TranscriptParse | TranscriptParse[],
): DepAnalysis {
  const transcripts = Array.isArray(parsed) ? parsed : [parsed];
  const profile = keepQuoted(analysis.profile, transcripts);
  const admissions = keepQuoted(analysis.admissions, transcripts);
  const impeachment = keepQuoted(analysis.impeachment, transcripts);
  const themes = keepQuoted(analysis.themes, transcripts);
  const objections = keepQuoted(analysis.objections, transcripts);
  const chronology = keepQuoted(analysis.chronology, transcripts);
  const exhibits = keepQuoted(analysis.exhibits, transcripts);
  const witnesses = keepQuoted(analysis.witnesses, transcripts);
  let extraDrop = 0;
  const contradictions = analysis.contradictions.flatMap((c) => {
    const a = matchDepEvidence(c.a, transcripts);
    const b = matchDepEvidence(c.b, transcripts);
    if (!a || !b) {
      extraDrop += 1;
      return [];
    }
    return [
      {
        ...c,
        a: { ...c.a, ...a },
        b: { ...c.b, ...b },
      },
    ];
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
    graph: {
      ...analysis.graph,
      edges: analysis.graph.edges.map((edge) => {
        const matched = matchDepEvidence(edge, transcripts);
        return matched
          ? { ...edge, ...matched }
          : { ...edge, evidenceStatus: "needs_review" as const };
      }),
    },
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
    notice: findings.filter(
      (f) => f.use === "notice" || f.tags.some((t) => /notice|knowledge/i.test(t)),
    ).length,
    impeach: analysis.impeachment.length + findings.filter((f) => f.use === "impeach").length,
    gaps: findings.filter((f) => f.use === "gap").length,
    conflicts: analysis.contradictions.length,
    exhibits: analysis.exhibits.length,
    people:
      analysis.graph.nodes.filter((n) => n.kind === "person").length || analysis.witnesses.length,
    edges: analysis.graph.edges.length,
  };
}

export function analysisToMarkdown(witness: string | null, analysis: DepAnalysis): string {
  const lines: string[] = [];
  lines.push(`# ${witness || "Deposition"}`);
  if (analysis.role) lines.push(`_${analysis.role}_`);
  if (analysis.summary) lines.push("", analysis.summary);
  const section = (
    title: string,
    items: { title: string; quote?: string; cite?: string; summary?: string; fileName?: string }[],
  ) => {
    if (!items.length) return;
    lines.push("", `## ${title}`);
    for (const item of items) {
      lines.push(
        `- **${item.title}**${item.cite ? ` (${[item.fileName, item.cite].filter(Boolean).join(" · ")})` : ""}`,
      );
      if (item.summary) lines.push(`  ${item.summary}`);
      if (item.quote) lines.push(`  > ${item.quote}`);
    }
  };
  section("Witness profile", analysis.profile);
  section("Admissions", analysis.admissions);
  section("Impeachment", analysis.impeachment);
  section(
    "Chronology",
    analysis.chronology.map((e) => ({
      title: `${e.date} — ${e.title}`,
      fileName: e.fileName,
      quote: e.quote,
      cite: e.cite,
      summary: e.summary,
    })),
  );
  section(
    "Exhibits",
    analysis.exhibits.map((e) => ({
      title: e.name,
      fileName: e.fileName,
      quote: e.quote,
      cite: e.cite,
      summary: e.summary,
    })),
  );
  section("Themes", analysis.themes);
  section(
    "Witnesses",
    analysis.witnesses.map((w) => ({
      title: w.name,
      fileName: w.fileName,
      quote: w.quote,
      cite: w.cite,
      summary: w.summary,
    })),
  );
  section(
    "Conflicts",
    analysis.contradictions.map((c) => ({
      title: c.title,
      cite: [c.a, c.b].map((s) => [s.fileName, s.cite].filter(Boolean).join(" · ")).join(" / "),
      summary: c.summary,
      quote: [
        c.a.quote && `${c.a.witness}: ${c.a.quote}`,
        c.b.quote && `${c.b.witness}: ${c.b.quote}`,
      ]
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
      lines.push(
        `- ${from} — ${e.label} → ${to} [${e.evidenceStatus === "source_matched" ? "source matched; interpretation requires review" : "needs review"}]${e.cite ? ` (${[e.fileName, e.cite].filter(Boolean).join(" · ")})` : ""}`,
      );
      if (e.quote) lines.push(`  > ${e.quote}`);
    }
  }
  return lines.join("\n");
}
