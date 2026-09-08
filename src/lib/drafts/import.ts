// Hand-off of an imported document's HTML from the Drafts landing page to the
// editor page, via sessionStorage (same pattern as the Library -> Discovery
// workspace hand-off). Bounded so a very large conversion degrades to text
// instead of overflowing storage.

const KEY_PREFIX = "sw:draft-import:";
const MAX_HTML_CHARS = 2_000_000;

export function stashDraftImport(draftId: string, html: string): void {
  try {
    const clean = sanitizeImportHtml(html);
    const payload =
      clean.length <= MAX_HTML_CHARS ? clean : htmlToText(clean).slice(0, MAX_HTML_CHARS);
    sessionStorage.setItem(KEY_PREFIX + draftId, payload);
  } catch {
    /* storage full or unavailable: the draft opens empty */
  }
}

export function takeDraftImport(draftId: string): string | null {
  try {
    const key = KEY_PREFIX + draftId;
    const value = sessionStorage.getItem(key);
    if (value !== null) sessionStorage.removeItem(key);
    return value;
  } catch {
    return null;
  }
}

/** Drop what the editor cannot keep faithfully (embedded images, scripts). */
export function sanitizeImportHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<img\b[^>]*>/gi, "")
    .replace(/\son\w+="[^"]*"/gi, "");
}

function htmlToText(html: string): string {
  return html
    .replace(/<\/(p|div|h[1-6]|li|tr)>/gi, "\n")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}
