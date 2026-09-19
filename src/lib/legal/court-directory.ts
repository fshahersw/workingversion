// ============================================================================
// Federal court directory lookups (pure, client-safe).
//
// Backed by the generated court-directory.gen.ts (from the public-law source
// registry): for each district, circuit and the JPML, the official site, the
// practice pages a filer needs (local rules, standing orders, judges' practices,
// forms, e-filing, admissions, ADR) and the JPML district report's active-MDL
// summary (count, pending actions, presiding judges, named MDLs with judge
// pages). Court ids follow the CourtListener/DocketBird convention already used
// by src/lib/courts.ts ("njd", "cand", "ca3", "jpml"), which is also the
// *.uscourts.gov host prefix, so matters, research grounding and Writer's
// court-style tool can all join on it deterministically.
// ============================================================================
import {
  COURT_DIRECTORY,
  COURT_DIRECTORY_AS_OF,
  type CourtDirectoryEntry,
  type CourtMdl,
  type CourtPages,
} from "./data/court-directory.gen";

export type { CourtDirectoryEntry, CourtMdl, CourtPages };
export { COURT_DIRECTORY_AS_OF };

const BY_ID = new Map(COURT_DIRECTORY.map((c) => [c.id, c] as const));
const BY_HOST = new Map(COURT_DIRECTORY.map((c) => [c.host, c] as const));

/** Court id for a *.uscourts.gov hostname ("www.njd.uscourts.gov" -> "njd"), else null. */
export function courtIdFromHost(hostname: string): string | null {
  const h = hostname.trim().toLowerCase().replace(/^www\./, "");
  const m = /^([a-z0-9]+)\.uscourts\.gov$/.exec(h);
  if (!m) return null;
  const id = m[1]!;
  return BY_ID.has(id) ? id : null;
}

/** Directory entry for a court id (case-insensitive), or null. */
export function courtDirectory(courtId: string | null | undefined): CourtDirectoryEntry | null {
  if (!courtId) return null;
  return BY_ID.get(courtId.trim().toLowerCase()) ?? null;
}

/** Directory entry for a URL or hostname on a court's official site, or null. */
export function courtDirectoryByUrl(urlOrHost: string): CourtDirectoryEntry | null {
  let host = urlOrHost.trim();
  try {
    if (/^https?:\/\//i.test(host)) host = new URL(host).hostname;
  } catch {
    return null;
  }
  return BY_HOST.get(host.toLowerCase().replace(/^www\./, "")) ?? null;
}

/** Every court that lists this MDL number in the JPML report, with the MDL row. */
export function courtsForMdl(mdlNumber: string | number): Array<{ court: CourtDirectoryEntry; mdl: CourtMdl }> {
  const n = String(mdlNumber).replace(/\D/g, "");
  if (!n) return [];
  const out: Array<{ court: CourtDirectoryEntry; mdl: CourtMdl }> = [];
  for (const court of COURT_DIRECTORY) {
    const mdl = court.mdls.find((m) => m.number === n);
    if (mdl) out.push({ court, mdl });
  }
  return out;
}

/** All directory entries (sorted by id). */
export function listCourtDirectory(): readonly CourtDirectoryEntry[] {
  return COURT_DIRECTORY;
}

const PAGE_LABEL: Record<keyof CourtPages, string> = {
  rules: "local rules",
  orders: "standing/general orders",
  judges: "judges' practices",
  forms: "forms",
  efiling: "e-filing",
  admissions: "attorney admissions",
  adr: "ADR",
};

/**
 * One compact, model-facing line of official practice links for a court, e.g.
 * "D.N.J. official: https://www.njd.uscourts.gov/ · local rules: … · standing/general orders: …".
 * `label` is the display name the caller already has (courtInfo().short).
 */
export function describeCourtLinks(entry: CourtDirectoryEntry, label?: string, roles?: ReadonlyArray<keyof CourtPages>): string {
  const wanted = roles ?? (["rules", "orders", "judges"] as const);
  const parts = [`${label ?? entry.id.toUpperCase()} official: ${entry.url}`];
  for (const role of wanted) {
    const url = entry.pages[role];
    if (url) parts.push(`${PAGE_LABEL[role]}: ${url}`);
  }
  return parts.join(" · ");
}

/** Model-facing summary of a court's active-MDL docket per the JPML report, or "". */
export function describeCourtMdls(entry: CourtDirectoryEntry): string {
  if (!entry.mdl) return "";
  const named = entry.mdls
    .map((m) => `MDL ${m.number} (${m.title}${m.pending !== null ? `, ${m.pending.toLocaleString("en-US")} pending` : ""}${m.judge ? `, Judge ${m.judge}` : ""})`)
    .join("; ");
  return (
    `${entry.mdl.active} active MDL${entry.mdl.active === 1 ? "" : "s"}, ${entry.mdl.pending.toLocaleString("en-US")} pending actions` +
    (entry.mdl.judges.length ? `; MDL judges: ${entry.mdl.judges.join(", ")}` : "") +
    (named ? `; ${named}` : "") +
    ` (JPML report via registry, verified ${COURT_DIRECTORY_AS_OF}).`
  );
}
