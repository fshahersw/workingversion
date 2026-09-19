// ============================================================================
// Build the public-law source registry assets from registry_vNN.jsonl.
//
//   bun scripts/build-public-law-registry.ts <path/to/registry_v06.jsonl>
//
// Emits two generated, committed TypeScript modules under src/lib/legal/data:
//
//   court-directory.gen.ts   small (client-safe): every *.uscourts.gov court in
//                            the registry keyed by its CourtListener/DocketBird
//                            id ("njd", "ca3", "jpml") with its official URL,
//                            practice pages (rules, standing orders, judges,
//                            forms, e-filing, admissions, ADR) and the JPML
//                            active-MDL summary (count, pending actions,
//                            presiding judges, named MDLs with judge routes).
//   source-domains.gen.ts    server-only: per-domain governance for every
//                            registry domain — source type, crawl policy,
//                            access, liveness share, jurisdictions, layers.
//
// The registry is public data. Nothing here is fetched; this is a pure
// transform, deterministic (sorted) so regenerating produces a stable diff.
// The MD rendering carries none of the per-record liveness/policy fields, so
// the JSONL is the only valid input.
// ============================================================================
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

type Rec = {
  id: string;
  name: string;
  url: string;
  domain: string;
  jurisdiction: string;
  layer: string;
  record_category: string;
  section: string;
  subsection: string;
  source_type: string;
  content_kind: string;
  access: string;
  crawl_policy: string;
  backend: string;
  description: string;
  verified_date: string;
  http_status: string;
  notes: string;
  task_family: string;
};

const input = process.argv[2];
if (!input) {
  console.error("usage: bun scripts/build-public-law-registry.ts <registry.jsonl>");
  process.exit(2);
}
const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, "..", "src", "lib", "legal", "data");
mkdirSync(outDir, { recursive: true });

const recs: Rec[] = readFileSync(input, "utf8")
  .split(/\r?\n/)
  .filter((l) => l.trim())
  .map((l) => JSON.parse(l) as Rec);

const verifiedDates = [...new Set(recs.map((r) => r.verified_date).filter(Boolean))].sort();
const asOf = verifiedDates[verifiedDates.length - 1] ?? "";

// --- Court directory ----------------------------------------------------------

type Pages = Partial<Record<"rules" | "orders" | "judges" | "forms" | "efiling" | "admissions" | "adr", string>>;
type NamedMdl = { number: string; title: string; pending: number | null; judgeUrl?: string; judge?: string };
type Court = {
  id: string;
  host: string;
  kind: "district" | "circuit" | "jpml";
  url: string;
  pages: Pages;
  mdl: { active: number; pending: number; judges: string[] } | null;
  mdls: NamedMdl[];
};

const ROLE_BY_NAME: Record<string, keyof Pages> = {
  rules: "rules",
  "rules/iops": "rules",
  orders: "orders",
  "orders/notices": "orders",
  judges: "judges",
  "judges/practices": "judges",
  forms: "forms",
  "e-filing": "efiling",
  admissions: "admissions",
  adr: "adr",
  "adr/mediation": "adr",
};

function courtIdFromHost(host: string): { id: string; kind: Court["kind"] } | null {
  const h = host.toLowerCase().replace(/^www\./, "");
  const m = /^([a-z0-9]+)\.uscourts\.gov$/.exec(h);
  if (!m) return null;
  const id = m[1]!;
  if (id === "jpml") return { id, kind: "jpml" };
  if (/^ca(\d{1,2}|dc|fc)$/.test(id)) return { id, kind: "circuit" };
  if (/^[a-z]{2,4}d$/.test(id)) return { id, kind: "district" };
  return null; // pacer, ecf.*, uscourts.gov itself, other national hosts
}

function num(s: string | undefined): number | null {
  if (!s) return null;
  const n = Number(s.replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
}

function judgeFromSlug(url: string): string {
  try {
    const seg = decodeURIComponent(new URL(url).pathname.split("/").filter(Boolean).pop() ?? "");
    return seg
      .split("-")
      .filter(Boolean)
      .map((w) => (w.length <= 2 && /^[a-z]$/.test(w) ? `${w.toUpperCase()}.` : w[0]!.toUpperCase() + w.slice(1)))
      .join(" ");
  } catch {
    return "";
  }
}

const courts = new Map<string, Court>();
const court = (host: string): Court | null => {
  const key = courtIdFromHost(host);
  if (!key) return null;
  let c = courts.get(key.id);
  if (!c) {
    c = { id: key.id, host: host.toLowerCase().replace(/^www\./, ""), kind: key.kind, url: "", pages: {}, mdl: null, mdls: [] };
    courts.set(key.id, c);
  }
  return c;
};

const SUMMARY_RE = /Active MDLs:\s*(\d+);\s*pending actions:\s*([\d,]+);\s*judges:\s*(.*)$/;
const NAMED_RE = /MDL\s+(\d{3,4})\s+—\s+(.*?);\s*pending actions:\s*([\d,]+)/;

for (const r of recs) {
  let host: string;
  try {
    host = new URL(r.url).hostname;
  } catch {
    continue;
  }
  const c = court(host);
  if (!c) continue;
  const name = r.name.trim().toLowerCase();
  if (name === "court" || name === "official court") {
    if (!c.url || r.http_status === "200") c.url = r.url;
  } else {
    const role = ROLE_BY_NAME[name];
    if (role && (!c.pages[role] || r.http_status === "200")) c.pages[role] = r.url;
  }
  const summary = SUMMARY_RE.exec(r.description);
  if (summary) {
    const judges = summary[3]!.split("|").map((j) => j.trim()).filter(Boolean);
    const active = num(summary[1]) ?? 0;
    const pending = num(summary[2]) ?? 0;
    if (!c.mdl || active > c.mdl.active) c.mdl = { active, pending, judges };
  }
  const named = NAMED_RE.exec(r.description);
  if (named) {
    const number = named[1]!;
    const isJudgeRoute = /judge\/court source/i.test(r.name);
    const existing = c.mdls.find((m) => m.number === number);
    const entry: NamedMdl = existing ?? { number, title: named[2]!.trim(), pending: num(named[3]) };
    if (isJudgeRoute) {
      entry.judgeUrl = r.url;
      entry.judge = judgeFromSlug(r.url);
    }
    if (!existing) c.mdls.push(entry);
  }
}
if (!courts.has("jpml")) courts.set("jpml", { id: "jpml", host: "jpml.uscourts.gov", kind: "jpml", url: "https://www.jpml.uscourts.gov/", pages: {}, mdl: null, mdls: [] });
const fold = (s: string) => s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
for (const c of courts.values()) {
  if (!c.url) c.url = `https://www.${c.host}/`;
  c.mdls.sort((a, b) => a.number.localeCompare(b.number));
  // A judge route names the judge only in its URL slug ("michael-shipp"); the
  // JPML summary carries the full form ("Michael A. Shipp"). Prefer the latter
  // when first and last name agree.
  for (const m of c.mdls) {
    if (!m.judge || !c.mdl) continue;
    const parts = fold(m.judge).split(/\s+/).filter(Boolean);
    const first = parts[0];
    const last = parts[parts.length - 1]?.replace(/\.$/, "");
    if (!first || !last) continue;
    const full = c.mdl.judges.find((j) => {
      const jp = fold(j).split(/\s+/).filter(Boolean);
      return jp[0] === first && jp[jp.length - 1]?.replace(/,$/, "") === last;
    });
    if (full) m.judge = full;
  }
}
const courtList = [...courts.values()].sort((a, b) => a.id.localeCompare(b.id));

// --- Source domains -------------------------------------------------------------

type DomainAgg = {
  n: number;
  live: number;
  types: Map<string, number>;
  policies: Set<string>;
  access: Set<string>;
  juris: Map<string, number>;
  layers: Map<string, number>;
  corpus: boolean;
};
const domains = new Map<string, DomainAgg>();
const bump = (m: Map<string, number>, k: string) => {
  if (k) m.set(k, (m.get(k) ?? 0) + 1);
};
for (const r of recs) {
  const d = r.domain.toLowerCase().replace(/^www\./, "");
  if (!d) continue;
  let a = domains.get(d);
  if (!a) {
    a = { n: 0, live: 0, types: new Map(), policies: new Set(), access: new Set(), juris: new Map(), layers: new Map(), corpus: false };
    domains.set(d, a);
  }
  a.n++;
  if (r.http_status === "200") a.live++;
  bump(a.types, r.source_type);
  if (r.crawl_policy) a.policies.add(r.crawl_policy);
  if (r.access && r.access !== "open") a.access.add(r.access);
  bump(a.juris, r.jurisdiction);
  bump(a.layers, r.layer);
  if (r.backend === "corpus") a.corpus = true;
}
const top = (m: Map<string, number>, k: number) =>
  [...m.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, k)
    .map(([v]) => v);
const TYPE_CODE: Record<string, string> = { official: "o", nonprofit_or_assoc: "n", commercial_or_thirdparty: "c", institutional: "i" };

// Row: [domain, typeCode, policy, access, livePct, count, jurisdictions, layers, corpus]
type Row = [string, string, string, string, number, number, string[], string[], number];
const rows: Row[] = [...domains.entries()]
  .sort((a, b) => a[0].localeCompare(b[0]))
  .map(([d, a]) => [
    d,
    TYPE_CODE[top(a.types, 1)[0] ?? ""] ?? "?",
    a.policies.has("never") ? "never" : a.policies.has("verify_only") ? "verify_only" : "",
    [...a.access].sort().join(","),
    Math.round((a.live / a.n) * 100),
    a.n,
    top(a.juris, 3),
    top(a.layers, 2),
    a.corpus ? 1 : 0,
  ]);

// --- Emit ------------------------------------------------------------------------

const header = (what: string) =>
  `// GENERATED by scripts/build-public-law-registry.ts from ${input.split(/[\\/]/).pop()} — do not edit.\n` +
  `// ${what}\n// Registry records: ${recs.length}; verified through ${asOf}.\n\n`;

const courtOut =
  header("Federal court directory (client-safe, ~40 KB): official URLs, practice pages, JPML active-MDL metadata.") +
  `export const COURT_DIRECTORY_AS_OF = ${JSON.stringify(asOf)};\n\n` +
  `export type CourtPages = Partial<Record<"rules" | "orders" | "judges" | "forms" | "efiling" | "admissions" | "adr", string>>;\n` +
  `export type CourtMdl = { number: string; title: string; pending: number | null; judgeUrl?: string; judge?: string };\n` +
  `export type CourtDirectoryEntry = {\n  id: string;\n  host: string;\n  kind: "district" | "circuit" | "jpml";\n  url: string;\n  pages: CourtPages;\n  /** JPML district report summary (report date in the registry section title). */\n  mdl: { active: number; pending: number; judges: string[] } | null;\n  mdls: CourtMdl[];\n};\n\n` +
  `export const COURT_DIRECTORY: readonly CourtDirectoryEntry[] = ${JSON.stringify(courtList, null, 1)};\n`;
writeFileSync(join(outDir, "court-directory.gen.ts"), courtOut);

const domainOut =
  header("Per-domain source governance (server-only, large). Row: [domain, type o|n|c|i, crawlPolicy, access, livePct, records, jurisdictions, layers, inCorpus].") +
  `export const SOURCE_DOMAINS_AS_OF = ${JSON.stringify(asOf)};\n\n` +
  `export type SourceDomainRow = readonly [string, string, string, string, number, number, readonly string[], readonly string[], number];\n\n` +
  `export const SOURCE_DOMAINS: readonly SourceDomainRow[] = ${JSON.stringify(rows)};\n`;
writeFileSync(join(outDir, "source-domains.gen.ts"), domainOut);

const withMdl = courtList.filter((c) => c.mdl).length;
console.log(
  `records=${recs.length} asOf=${asOf} courts=${courtList.length} (districts=${courtList.filter((c) => c.kind === "district").length}, circuits=${courtList.filter((c) => c.kind === "circuit").length}, withMdl=${withMdl}, namedMdls=${courtList.reduce((n, c) => n + c.mdls.length, 0)}) domains=${rows.length} never=${rows.filter((r) => r[2] === "never").length} verifyOnly=${rows.filter((r) => r[2] === "verify_only").length}`,
);
