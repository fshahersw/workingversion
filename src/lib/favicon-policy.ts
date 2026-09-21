// ============================================================================
// Favicon fetch policy (pure, shared by the Favicon component).
//
// The source panel renders one favicon per cited host. The DuckDuckGo icon
// proxy 404s for many government hosts (uscourts.gov and its district
// subdomains, regulations.gov, ...), and every re-render re-requested the same
// dead URL, so a long research answer spammed the console with 404s. Policy:
//   1. hosts on the known-no-favicon list never hit the network;
//   2. a host that failed once is remembered for the session (memory +
//      sessionStorage) and not requested again;
//   3. government / court hosts get a landmark glyph rather than a monogram.
// ============================================================================

/** Host suffixes whose favicon lookups are known to 404 at the proxy. */
export const KNOWN_NO_FAVICON_SUFFIXES: readonly string[] = [
  "uscourts.gov",
  "regulations.gov",
  "govinfo.gov",
  "federalregister.gov",
  "ecfr.gov",
  "pacer.gov",
  "supremecourt.gov",
  "justice.gov",
  "fda.gov",
  "cdc.gov",
  "nih.gov",
  "epa.gov",
  "sec.gov",
  "ftc.gov",
  "congress.gov",
  "law.cornell.edu",
];

const STORAGE_KEY = "sw:favicon-miss";
const MAX_REMEMBERED = 500;

const misses = new Set<string>();
let hydrated = false;

function storage(): Storage | null {
  try {
    return typeof sessionStorage === "undefined" ? null : sessionStorage;
  } catch {
    return null;
  }
}

function hydrate(): void {
  if (hydrated) return;
  hydrated = true;
  try {
    const raw = storage()?.getItem(STORAGE_KEY);
    if (!raw) return;
    const list = JSON.parse(raw) as unknown;
    if (Array.isArray(list)) for (const h of list) if (typeof h === "string") misses.add(h);
  } catch {
    /* corrupt entry: start clean */
  }
}

export function normalizeHost(host: string): string {
  return host.trim().toLowerCase().replace(/^www\./, "");
}

export function hostMatchesSuffix(host: string, suffix: string): boolean {
  const h = normalizeHost(host);
  const s = suffix.toLowerCase();
  return h === s || h.endsWith(`.${s}`);
}

/** True when a network lookup for this host is pointless (list or remembered miss). */
export function shouldSkipFaviconFetch(host: string): boolean {
  hydrate();
  const h = normalizeHost(host);
  if (misses.has(h)) return true;
  return KNOWN_NO_FAVICON_SUFFIXES.some((s) => hostMatchesSuffix(h, s));
}

/** Remember a failed lookup for the rest of the session. */
export function rememberFaviconMiss(host: string): void {
  hydrate();
  const h = normalizeHost(host);
  if (!h || misses.has(h)) return;
  misses.add(h);
  if (misses.size > MAX_REMEMBERED) {
    const first = misses.values().next().value as string | undefined;
    if (first) misses.delete(first);
  }
  try {
    storage()?.setItem(STORAGE_KEY, JSON.stringify([...misses]));
  } catch {
    /* quota or private mode: memory cache still applies */
  }
}

/** Test hook. */
export function resetFaviconMisses(): void {
  misses.clear();
  hydrated = false;
  try {
    storage()?.removeItem(STORAGE_KEY);
  } catch {
    /* ignore */
  }
}

/** Government / court / military hosts: rendered with a landmark glyph instead of a monogram. */
export function isInstitutionalHost(host: string): boolean {
  const h = normalizeHost(host);
  return /\.(gov|mil)$/.test(h) || /(^|\.)(gov|gc)\.[a-z]{2}$/.test(h) || hostMatchesSuffix(h, "law.cornell.edu");
}

export function faviconProxyUrl(host: string): string {
  return `https://icons.duckduckgo.com/ip3/${encodeURIComponent(normalizeHost(host))}.ico`;
}
