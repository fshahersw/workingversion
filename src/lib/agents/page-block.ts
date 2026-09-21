// ============================================================================
// Deterministic "did we actually get the page?" classifier for fetched pages
// (pure; shared by the resilient reader and its tests).
//
// A fetch can return 200 and still hand the model nothing usable: a Cloudflare
// "Just a moment…" challenge, a cookie-consent interstitial, an "enable
// JavaScript" shell, a login wall, a bot-detection page. The reader escalates
// to a rendering scraper only when this says the direct fetch was blocked or
// empty, so the fast path stays fast for the ordinary case.
// ============================================================================

export type PageProbe = {
  status: number;
  contentType: string;
  title: string;
  text: string;
  /** raw HTML when available (script-heaviness check); optional */
  html?: string;
};

export type BlockVerdict =
  | { blocked: false }
  | {
      blocked: true;
      reason: "http-status" | "challenge" | "consent" | "login" | "javascript" | "empty" | "not-found";
      detail: string;
      /** a rendering scraper is likely to help (false for login walls / 404) */
      retryable: boolean;
    };

const CHALLENGE_RE =
  /\b(just a moment|checking your browser|verify(?:ing)? (?:that )?you are (?:a )?human|are you a robot|access denied|request unsuccessful|attention required|bot detection|security check|ddos protection|please enable cookies|cf-browser-verification|captcha|unusual traffic|automated access|blocked by|forbidden)\b/i;
const CONSENT_RE =
  /\b(accept (?:all )?cookies|cookie (?:consent|preferences|settings|policy)|we use cookies|manage (?:your )?(?:cookie|privacy) (?:preferences|settings)|before you continue|your privacy choices|consent to the use of)\b/i;
const LOGIN_RE =
  /\b(sign in to continue|log in to (?:view|continue|read)|subscribe to (?:read|continue)|subscription required|create a free account|already a subscriber|this content is for subscribers)\b/i;
const JS_RE =
  /\b(enable javascript|javascript is (?:required|disabled)|requires javascript|turn on javascript|you need to enable javascript)\b/i;
const NOT_FOUND_RE = /\b(page not found|404 not found|the page you requested (?:could not be found|does not exist)|no longer available)\b/i;

/** Text length below which an HTML page is treated as a shell, not content. */
export const MIN_USEFUL_CHARS = 400;

export function classifyPage(page: PageProbe): BlockVerdict {
  const text = (page.text ?? "").replace(/\s+/g, " ").trim();
  const head = `${page.title ?? ""} ${text.slice(0, 1500)}`;
  const status = page.status;

  if (status === 404 || status === 410) {
    return { blocked: true, reason: "not-found", detail: `HTTP ${status}`, retryable: false };
  }
  if (status === 401 || status === 402) {
    return { blocked: true, reason: "login", detail: `HTTP ${status}`, retryable: false };
  }
  if ([403, 406, 409, 429, 451, 503, 520, 521, 522, 523, 524, 525, 526, 529, 530].includes(status)) {
    return { blocked: true, reason: "http-status", detail: `HTTP ${status}`, retryable: true };
  }
  if (status >= 400) {
    return { blocked: true, reason: "http-status", detail: `HTTP ${status}`, retryable: status >= 500 };
  }

  const isHtml = (page.contentType ?? "").includes("html") || /^\s*</.test(page.html ?? "");
  const short = text.length < MIN_USEFUL_CHARS;

  // Only interstitial pages are short; a real article that happens to mention
  // cookies in its footer is long and passes.
  if (short && CHALLENGE_RE.test(head)) {
    return { blocked: true, reason: "challenge", detail: "bot challenge / access denied page", retryable: true };
  }
  if (short && LOGIN_RE.test(head)) {
    return { blocked: true, reason: "login", detail: "login or subscription wall", retryable: false };
  }
  if (short && JS_RE.test(head)) {
    return { blocked: true, reason: "javascript", detail: "page requires JavaScript to render", retryable: true };
  }
  if (short && CONSENT_RE.test(head)) {
    return { blocked: true, reason: "consent", detail: "cookie-consent interstitial", retryable: true };
  }
  if (short && NOT_FOUND_RE.test(head)) {
    return { blocked: true, reason: "not-found", detail: "not-found page", retryable: false };
  }
  if (isHtml && short) {
    // A script-heavy shell with almost no text is a client-rendered app.
    const html = page.html ?? "";
    const scriptTags = (html.match(/<script\b/gi) ?? []).length;
    if (!html || scriptTags >= 3 || text.length < 80) {
      return {
        blocked: true,
        reason: text.length < 80 ? "empty" : "javascript",
        detail: text.length < 80 ? "no readable text" : `client-rendered shell (${scriptTags} scripts, ${text.length} chars)`,
        retryable: true,
      };
    }
  }
  return { blocked: false };
}

/** Compact, model-facing note for the fallback that produced the text. */
export function viaNote(via: "direct" | "firecrawl" | "tavily", verdict: BlockVerdict | null): string {
  if (via === "direct" || !verdict || !verdict.blocked) return "";
  const cause = verdict.reason === "http-status" ? verdict.detail : verdict.detail || verdict.reason;
  return `Read through ${via === "firecrawl" ? "a rendering scraper" : "an extraction service"} because the direct fetch was blocked (${cause}).`;
}
