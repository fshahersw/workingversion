// ============================================================================
// fetch_page (server-only): fetch a URL and return readable text + links.
//
// The single biggest accuracy lever for the research agent — it lets the model
// READ a primary source (a court opinion page, an agency rule, a news article)
// instead of reasoning from a search snippet. Dependency-light: no headless
// browser, no HTML-parser lib. Heavy/interactive/JS-rendered pages are a later
// AgentCore Browser job; this covers the large majority of text-first pages.
// Filing PDFs are better read via CourtListener RECAP plain_text.
// ============================================================================
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

export type FetchedPage = {
  url: string;
  finalUrl: string;
  status: number;
  contentType: string;
  title: string;
  text: string;
  links: { href: string; text: string }[];
  truncated: boolean;
  note?: string;
};

export type FetchPageDnsAnswer = {
  address: string;
  family?: number | string;
};

export type FetchPageDnsResolver = (
  hostname: string,
) => Promise<readonly FetchPageDnsAnswer[]>;

export type FetchPageOptions = {
  maxChars?: number;
  maxBytes?: number;
  maxRedirects?: number;
  signal?: AbortSignal;
  timeoutMs?: number;
  resolver?: FetchPageDnsResolver;
  fetchImpl?: typeof fetch;
};

const DEFAULT_MAX_CHARS = 12_000;
export const MAX_RESPONSE_BYTES = 1_000_000;
export const MAX_REDIRECTS = 3;
export const MAX_TIMEOUT_MS = 30_000;
const UA =
  "Mozilla/5.0 (compatible; SeegerWeissResearch/1.0; +https://seegerweiss.com)";

const BLOCKED_HOSTNAMES = new Set([
  "instance-data",
  "instance-data.ec2.internal",
  "metadata",
  "metadata.aws.internal",
  "metadata.azure.internal",
  "metadata.google",
  "metadata.google.internal",
]);

function withoutBrackets(hostname: string): string {
  return hostname.startsWith("[") && hostname.endsWith("]")
    ? hostname.slice(1, -1)
    : hostname;
}

function normalizedHostname(hostname: string): string {
  return withoutBrackets(hostname).toLowerCase().replace(/\.$/, "");
}

function blockedHostname(hostname: string): boolean {
  const host = normalizedHostname(hostname);
  return (
    BLOCKED_HOSTNAMES.has(host) ||
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host === "localhost.localdomain" ||
    host.endsWith(".localdomain") ||
    host.endsWith(".local") ||
    host.endsWith(".internal") ||
    host.endsWith(".home.arpa") ||
    host.endsWith(".lan")
  );
}

function ipv4Octets(address: string): number[] | null {
  if (isIP(address) !== 4) return null;
  const octets = address.split(".").map(Number);
  return octets.length === 4 ? octets : null;
}

function blockedIpv4(address: string): boolean {
  const octets = ipv4Octets(address);
  if (!octets) return true;
  const [a, b, c] = octets;
  return (
    a === 0 ||
    a === 10 ||
    (a === 100 && b >= 64 && b <= 127) ||
    a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0 && (c === 0 || c === 2)) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 88 && c === 99) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113) ||
    a >= 224
  );
}

function ipv6Bytes(address: string): Uint8Array | null {
  let source = address.toLowerCase();
  if (source.includes("%") || isIP(source) !== 6) return null;

  if (source.includes(".")) {
    const lastColon = source.lastIndexOf(":");
    const tail = ipv4Octets(source.slice(lastColon + 1));
    if (!tail) return null;
    source =
      source.slice(0, lastColon + 1) +
      `${((tail[0] << 8) | tail[1]).toString(16)}:${((tail[2] << 8) | tail[3]).toString(16)}`;
  }

  const halves = source.split("::");
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const missing = 8 - left.length - right.length;
  if ((halves.length === 1 && missing !== 0) || (halves.length === 2 && missing < 1)) {
    return null;
  }

  const groups = [
    ...left,
    ...Array.from({ length: missing }, () => "0"),
    ...right,
  ];
  if (groups.length !== 8) return null;

  const bytes = new Uint8Array(16);
  for (let i = 0; i < groups.length; i++) {
    if (!/^[0-9a-f]{1,4}$/.test(groups[i])) return null;
    const value = Number.parseInt(groups[i], 16);
    bytes[i * 2] = value >> 8;
    bytes[i * 2 + 1] = value & 0xff;
  }
  return bytes;
}

function blockedIpv6(address: string): boolean {
  const bytes = ipv6Bytes(address);
  if (!bytes) return true;

  const mappedIpv4 =
    bytes.slice(0, 10).every((value) => value === 0) &&
    bytes[10] === 0xff &&
    bytes[11] === 0xff;
  if (mappedIpv4) {
    return blockedIpv4(
      `${bytes[12]}.${bytes[13]}.${bytes[14]}.${bytes[15]}`,
    );
  }

  // Only globally routable unicast is eligible. Explicit exclusions below are
  // special-use ranges that sit inside 2000::/3.
  if ((bytes[0] & 0xe0) !== 0x20) return true;
  if (bytes[0] === 0x20 && bytes[1] === 0x01 && bytes[2] <= 0x01) return true;
  if (
    bytes[0] === 0x20 &&
    bytes[1] === 0x01 &&
    bytes[2] === 0x0d &&
    bytes[3] === 0xb8
  ) {
    return true;
  }
  if (bytes[0] === 0x20 && bytes[1] === 0x02) return true;
  if (
    bytes[0] === 0x3f &&
    bytes[1] === 0xff &&
    (bytes[2] & 0xf0) === 0
  ) {
    return true;
  }
  return false;
}

export function isBlockedIpAddress(address: string): boolean {
  const normalized = withoutBrackets(address);
  const family = isIP(normalized);
  if (family === 4) return blockedIpv4(normalized);
  if (family === 6) return blockedIpv6(normalized);
  return true;
}

export function parseFetchTarget(input: string | URL): URL {
  let target: URL;
  try {
    target = new URL(input.toString());
  } catch {
    throw new Error(`Invalid URL: ${input.toString()}`);
  }

  if (target.protocol !== "http:" && target.protocol !== "https:") {
    throw new Error("Only http(s) URLs are allowed.");
  }
  if (target.username || target.password) {
    throw new Error("URLs containing credentials are not allowed.");
  }
  const expectedPort = target.protocol === "http:" ? "80" : "443";
  if (target.port && target.port !== expectedPort) {
    throw new Error(`Only the standard ${expectedPort} port is allowed for ${target.protocol}`);
  }

  const hostname = normalizedHostname(target.hostname);
  if (!hostname || blockedHostname(hostname)) {
    throw new Error(`Blocked URL hostname: ${hostname || "(empty)"}`);
  }
  if (isIP(hostname) && isBlockedIpAddress(hostname)) {
    throw new Error(`Blocked IP address: ${hostname}`);
  }
  target.hash = "";
  return target;
}

async function defaultResolver(
  hostname: string,
): Promise<readonly FetchPageDnsAnswer[]> {
  return lookup(hostname, { all: true, verbatim: true });
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("The operation was aborted.", "AbortError");
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortReason(signal);
}

async function withAbort<T>(
  promise: Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  if (!signal) return promise;
  throwIfAborted(signal);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortReason(signal));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

export async function validateFetchTarget(
  input: string | URL,
  resolver: FetchPageDnsResolver = defaultResolver,
  signal?: AbortSignal,
): Promise<URL> {
  throwIfAborted(signal);
  const target = parseFetchTarget(input);
  const hostname = normalizedHostname(target.hostname);
  if (isIP(hostname)) return target;

  let answers: readonly FetchPageDnsAnswer[];
  try {
    answers = await withAbort(resolver(hostname), signal);
  } catch (error) {
    throwIfAborted(signal);
    throw new Error(
      `DNS resolution failed for ${hostname}: ${error instanceof Error ? error.message : "unknown error"}`,
    );
  }
  if (!answers.length) throw new Error(`DNS resolution returned no addresses for ${hostname}`);
  for (const answer of answers) {
    if (isBlockedIpAddress(answer.address)) {
      throw new Error(`DNS for ${hostname} resolved to a blocked address`);
    }
  }
  return target;
}

const ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ",
  mdash: "—", ndash: "–", hellip: "…", rsquo: "’",
  lsquo: "‘", ldquo: "“", rdquo: "”", sect: "§",
};

function decodeEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => safeCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => safeCodePoint(parseInt(d, 10)))
    .replace(/&([a-z]+);/gi, (m, name) => ENTITIES[name.toLowerCase()] ?? m);
}
function safeCodePoint(n: number): string {
  try {
    return Number.isFinite(n) && n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : "";
  } catch {
    return "";
  }
}

function extractTitle(html: string): string {
  const m = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  return m ? decodeEntities(m[1].replace(/\s+/g, " ").trim()).slice(0, 300) : "";
}

function extractLinks(html: string, base: string): { href: string; text: string }[] {
  const out: { href: string; text: string }[] = [];
  const seen = new Set<string>();
  const re = /<a\b[^>]*?href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) && out.length < 60) {
    const raw = m[1].trim();
    if (!raw || raw.startsWith("#") || raw.startsWith("javascript:") || raw.startsWith("mailto:")) continue;
    let href: string;
    try {
      href = new URL(raw, base).toString();
    } catch {
      continue;
    }
    if (!/^https?:/i.test(href) || seen.has(href)) continue;
    seen.add(href);
    const text = decodeEntities(m[2].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim()).slice(0, 120);
    out.push({ href, text });
  }
  return out;
}

/** Strip HTML to readable text, preserving block structure as line breaks. */
function htmlToText(html: string): string {
  let s = html;
  // Drop non-content regions entirely.
  s = s.replace(/<(script|style|noscript|svg|head|nav|footer|header|form|aside)\b[^>]*>[\s\S]*?<\/\1>/gi, " ");
  s = s.replace(/<!--[\s\S]*?-->/g, " ");
  // Headings/paragraphs/list items/rows -> newlines so structure survives.
  s = s.replace(/<\/(p|div|section|article|li|tr|h[1-6]|blockquote|pre)>/gi, "\n");
  s = s.replace(/<br\s*\/?>/gi, "\n");
  s = s.replace(/<li\b[^>]*>/gi, "\n- ");
  s = s.replace(/<h[1-6]\b[^>]*>/gi, "\n\n");
  // Remove all remaining tags.
  s = s.replace(/<[^>]+>/g, " ");
  s = decodeEntities(s);
  // Collapse whitespace but keep paragraph breaks.
  s = s.replace(/[ \t\f\v]+/g, " ").replace(/ *\n */g, "\n").replace(/\n{3,}/g, "\n\n");
  return s.trim();
}

function boundedInteger(
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const candidate = value === undefined ? fallback : Math.floor(value);
  return Number.isFinite(candidate)
    ? Math.max(minimum, Math.min(candidate, maximum))
    : fallback;
}

async function cancelBody(response: Response): Promise<void> {
  await response.body?.cancel().catch(() => undefined);
}

async function readBoundedBody(
  response: Response,
  maxBytes: number,
  signal: AbortSignal,
): Promise<string> {
  const contentLength = response.headers.get("content-length");
  if (contentLength) {
    const declaredBytes = Number(contentLength);
    if (Number.isFinite(declaredBytes) && declaredBytes > maxBytes) {
      await cancelBody(response);
      throw new Error(`Response exceeds the ${maxBytes}-byte limit`);
    }
  }
  if (!response.body) return "";

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytesRead = 0;
  let output = "";
  try {
    while (true) {
      const { done, value } = await withAbort(reader.read(), signal);
      if (done) break;
      bytesRead += value.byteLength;
      if (bytesRead > maxBytes) {
        throw new Error(`Response exceeds the ${maxBytes}-byte limit`);
      }
      output += decoder.decode(value, { stream: true });
    }
    return output + decoder.decode();
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }
}

function redirectLocation(response: Response): string | null {
  return [301, 302, 303, 307, 308].includes(response.status)
    ? response.headers.get("location")
    : null;
}

export async function fetchPage(
  url: string,
  opts?: FetchPageOptions,
): Promise<FetchedPage> {
  const timeoutMs = boundedInteger(opts?.timeoutMs, 25_000, 1, MAX_TIMEOUT_MS);
  const maxBytes = boundedInteger(
    opts?.maxBytes,
    MAX_RESPONSE_BYTES,
    1,
    MAX_RESPONSE_BYTES,
  );
  const maxChars = boundedInteger(
    opts?.maxChars,
    DEFAULT_MAX_CHARS,
    0,
    MAX_RESPONSE_BYTES,
  );
  const maxRedirects = boundedInteger(
    opts?.maxRedirects,
    MAX_REDIRECTS,
    0,
    MAX_REDIRECTS,
  );
  const resolver = opts?.resolver ?? defaultResolver;
  const fetchImpl = opts?.fetchImpl ?? globalThis.fetch;
  const controller = new AbortController();
  const timeoutError = new Error(`fetch_page timed out after ${timeoutMs}ms`);
  timeoutError.name = "TimeoutError";
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort(timeoutError);
  }, timeoutMs);
  const onCallerAbort = () => {
    if (opts?.signal) controller.abort(abortReason(opts.signal));
  };
  if (opts?.signal?.aborted) onCallerAbort();
  else opts?.signal?.addEventListener("abort", onCallerAbort, { once: true });

  try {
    let target = parseFetchTarget(url);
    let redirects = 0;

    while (true) {
      target = await validateFetchTarget(target, resolver, controller.signal);

      let response: Response;
      try {
        // DNS validation and native fetch use separate connection paths. This
        // reduces SSRF risk but cannot fully eliminate DNS rebinding without
        // pinning the validated address at socket connection time.
        response = await fetchImpl(target.toString(), {
          headers: {
            "User-Agent": UA,
            Accept: "text/html,application/xhtml+xml,text/plain,*/*",
          },
          redirect: "manual",
          signal: controller.signal,
        });
      } catch (error) {
        throwIfAborted(controller.signal);
        throw new Error(
          `fetch_page failed for ${target.hostname}: ${error instanceof Error ? error.message : "network error"}`,
        );
      }

      const location = redirectLocation(response);
      if (location) {
        await cancelBody(response);
        let nextTarget: URL;
        try {
          nextTarget = parseFetchTarget(new URL(location, target));
        } catch (error) {
          throw new Error(
            `Blocked redirect target: ${error instanceof Error ? error.message : "invalid URL"}`,
          );
        }
        if (redirects >= maxRedirects) {
          throw new Error(`Too many redirects (maximum ${maxRedirects})`);
        }
        redirects += 1;
        target = nextTarget;
        continue;
      }

      const contentType = (response.headers.get("content-type") || "").toLowerCase();
      const finalUrl = target.toString();

      if (contentType.includes("application/pdf")) {
        await cancelBody(response);
        return {
          url,
          finalUrl,
          status: response.status,
          contentType,
          title: "",
          text: "",
          links: [],
          truncated: false,
          note: "This is a PDF. For a court filing, read its text via db_read_filing (DocketBird); general PDFs are not yet text-extracted here.",
        };
      }

      const body = await readBoundedBody(response, maxBytes, controller.signal);
      if (contentType.includes("application/json")) {
        const text = body.slice(0, maxChars);
        return {
          url,
          finalUrl,
          status: response.status,
          contentType,
          title: "",
          text,
          links: [],
          truncated: body.length > maxChars,
        };
      }

      const isHtml =
        contentType.includes("html") ||
        /^\s*<(!doctype|html|head|body)/i.test(body);
      const title = isHtml ? extractTitle(body) : "";
      const links = isHtml ? extractLinks(body, finalUrl) : [];
      const raw = isHtml ? htmlToText(body) : body;
      const text = raw.slice(0, maxChars);

      return {
        url,
        finalUrl,
        status: response.status,
        contentType,
        title,
        text,
        links,
        truncated: raw.length > maxChars,
      };
    }
  } catch (error) {
    if (opts?.signal?.aborted) throw abortReason(opts.signal);
    if (timedOut) throw timeoutError;
    throw error;
  } finally {
    clearTimeout(timer);
    opts?.signal?.removeEventListener("abort", onCallerAbort);
  }
}
