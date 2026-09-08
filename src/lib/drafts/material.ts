// ============================================================================
// Document material: the pure rules for what the Drafts assistant proposes.
// Client and server share this file (no imports from either side).
// ============================================================================
import type { Source } from "@/lib/chat-types";

/** Separates the chat note from the document material in a two-part reply. */
export const CONTENT_MARKER = "<<<CONTENT>>>";

/** Split a two-part reply. Material is null when the reply has no marker. */
export function splitMaterial(answer: string): { note: string; material: string | null } {
  const idx = answer.indexOf(CONTENT_MARKER);
  if (idx < 0) return { note: answer.trim(), material: null };
  const note = answer.slice(0, idx).trim();
  const material = answer
    .slice(idx + CONTENT_MARKER.length)
    .replace(/^\s*\n/, "")
    .trimEnd();
  return { note, material: material.trim() ? material : null };
}

/** True while a streaming reply has started the marker but not finished it. */
export function hasPartialMarker(answer: string): boolean {
  if (answer.includes(CONTENT_MARKER)) return false;
  for (let len = CONTENT_MARKER.length - 1; len >= 3; len--) {
    if (answer.endsWith(CONTENT_MARKER.slice(0, len))) return true;
  }
  return false;
}

const REF_RE = /\[\s*(S\d{1,3}(?:\s*,\s*S\d{1,3})*)\s*\]/gi;

export type ReferencedSource = { n: number; ref: string; source: Source | null };

/**
 * Turn the assistant's [S#] markers into the document's own numbered
 * references: "[S7]" becomes "[1]" (linked when the source has a URL), with a
 * Sources list appended for the references used in this passage. Numbering
 * starts at `startAt` so successive inserts continue the count.
 */
export function materialForDocument(
  material: string,
  sources: Source[],
  startAt = 1,
): { markdown: string; used: ReferencedSource[] } {
  const byRef = new Map(sources.map((s) => [s.ref.toUpperCase(), s]));
  const order: string[] = [];
  const numberOf = (ref: string): number => {
    const key = ref.toUpperCase();
    let i = order.indexOf(key);
    if (i < 0) {
      order.push(key);
      i = order.length - 1;
    }
    return startAt + i;
  };
  const body = material.replace(REF_RE, (_m, group: string) => {
    const refs = group.split(",").map((r) => r.trim());
    return refs
      .map((ref) => {
        const n = numberOf(ref);
        const src = byRef.get(ref.toUpperCase());
        return src?.source_url ? `[[${n}]](${src.source_url})` : `[${n}]`;
      })
      .join("");
  });
  const used: ReferencedSource[] = order.map((key, i) => ({
    n: startAt + i,
    ref: key,
    source: byRef.get(key) ?? null,
  }));
  if (!used.length) return { markdown: body.trim(), used };
  const lines = used.map(({ n, source, ref }) => {
    if (!source) return `${n}. Source ${ref} (not in the retrieved record)`;
    return `${n}. ${referenceLine(source)}`;
  });
  return { markdown: `${body.trim()}\n\n**Sources**\n\n${lines.join("\n")}`, used };
}

/** One reference line: a readable label, a real date if there is one, the URL once. */
export function referenceLine(source: Source): string {
  const url = source.source_url?.trim() ?? "";
  const rawCitation = (source.citation ?? "").trim();
  const citationIsUrl = /^https?:\/\//i.test(rawCitation);
  const label = citationIsUrl
    ? labelFromUrl(rawCitation)
    : rawCitation || (url ? labelFromUrl(url) : "Source");
  const date = cleanDate(source.effective_date);
  const parts = [label];
  if (date) parts.push(`(${date})`);
  if (url && url !== label) parts.push(`— ${url}`);
  return parts.join(" ");
}

function labelFromUrl(url: string): string {
  try {
    const u = new URL(url);
    const file = decodeURIComponent(u.pathname.split("/").filter(Boolean).pop() ?? "");
    const host = u.hostname.replace(/^www\./, "");
    return file && file !== host ? `${host} — ${file}` : host;
  } catch {
    return url;
  }
}

/** Keep a date only when it looks like one; drop "unknown" and clock noise. */
function cleanDate(value: string | undefined): string {
  const v = (value ?? "").trim();
  if (!v || /^(unknown|n\/a|none|null)$/i.test(v)) return "";
  const iso = v.match(/\b(\d{4}-\d{2}-\d{2})\b/);
  if (iso) return iso[1]!;
  const long = v.match(/\b([A-Z][a-z]+ \d{1,2},? \d{4})\b/);
  if (long) return long[1]!;
  return /\d{4}/.test(v) ? v.slice(0, 40) : "";
}

/** Highest "[n]" reference already in the document, so new inserts continue it. */
export function nextReferenceNumber(documentText: string): number {
  let max = 0;
  for (const m of documentText.matchAll(/\[(\d{1,3})\]/g)) {
    const n = Number(m[1]);
    if (n > max) max = n;
  }
  return max + 1;
}
