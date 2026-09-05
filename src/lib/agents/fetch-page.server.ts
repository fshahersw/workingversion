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

const DEFAULT_MAX_CHARS = 12_000;
const UA =
  "Mozilla/5.0 (compatible; SeegerWeissResearch/1.0; +https://seegerweiss.com)";

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

export async function fetchPage(
  url: string,
  opts?: { maxChars?: number; signal?: AbortSignal; timeoutMs?: number },
): Promise<FetchedPage> {
  let target: URL;
  try {
    target = new URL(url);
  } catch {
    throw new Error(`Invalid URL: ${url}`);
  }
  if (!/^https?:$/.test(target.protocol)) throw new Error("Only http(s) URLs are allowed.");

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts?.timeoutMs ?? 25_000);
  if (opts?.signal) opts.signal.addEventListener("abort", () => controller.abort());

  let res: Response;
  try {
    res = await fetch(target.toString(), {
      headers: { "User-Agent": UA, Accept: "text/html,application/xhtml+xml,text/plain,*/*" },
      redirect: "follow",
      signal: controller.signal,
    });
  } catch (err) {
    throw new Error(`fetch_page failed for ${target.hostname}: ${err instanceof Error ? err.message : "network error"}`);
  } finally {
    clearTimeout(timer);
  }

  const contentType = (res.headers.get("content-type") || "").toLowerCase();
  const finalUrl = res.url || target.toString();
  const maxChars = opts?.maxChars ?? DEFAULT_MAX_CHARS;

  if (contentType.includes("application/pdf")) {
    return {
      url, finalUrl, status: res.status, contentType, title: "", text: "",
      links: [], truncated: false,
      note: "This is a PDF. For a court filing, read it via CourtListener RECAP (recap_read) for extracted text; general PDFs are not yet text-extracted here.",
    };
  }

  const body = await res.text();
  if (contentType.includes("application/json")) {
    const text = body.slice(0, maxChars);
    return { url, finalUrl, status: res.status, contentType, title: "", text, links: [], truncated: body.length > maxChars };
  }

  const isHtml = contentType.includes("html") || /^\s*<(!doctype|html|head|body)/i.test(body);
  const title = isHtml ? extractTitle(body) : "";
  const links = isHtml ? extractLinks(body, finalUrl) : [];
  const raw = isHtml ? htmlToText(body) : body;
  const text = raw.slice(0, maxChars);

  return {
    url, finalUrl, status: res.status, contentType,
    title, text, links, truncated: raw.length > maxChars,
  };
}
