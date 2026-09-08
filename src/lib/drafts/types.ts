// ============================================================================
// Drafts: the web Word/PDF surfaces. Shared types (client + server).
//
// A draft is an owner-scoped Library row (ITEM#<draftId>, type "draft") whose
// body lives in S3 as a versioned JSON envelope. The Word surface stores the
// editor document (TipTap JSON) plus a plain-text snapshot the AI panel and
// search can read without the editor; the PDF surface stores the original file
// key plus annotations.
// ============================================================================

export type DraftKind = "word" | "pdf";

/** Visual style applied on export (and as the editor theme). Matches docgen. */
export type DraftStyle = "legal" | "modern" | "minimal";

export const DRAFT_STYLES: readonly DraftStyle[] = ["legal", "modern", "minimal"];

export function isDraftStyle(value: unknown): value is DraftStyle {
  return typeof value === "string" && (DRAFT_STYLES as readonly string[]).includes(value);
}

export function isDraftKind(value: unknown): value is DraftKind {
  return value === "word" || value === "pdf";
}

export const MAX_DRAFT_TITLE = 160;
/** Editor JSON + text snapshot, generous for long memoranda. */
export const MAX_DRAFT_CONTENT_BYTES = 6 * 1024 * 1024;

export type DraftSummary = {
  draftId: string;
  kind: DraftKind;
  title: string;
  style: DraftStyle;
  folderId: string;
  /** Monotonic save counter; the client sends the version it loaded so a stale
   *  tab never overwrites a newer save. */
  version: number;
  wordCount: number;
  createdAt: string;
  updatedAt: string;
  /** Chat conversation the draft's AI panel writes to, once one exists. */
  convId?: string;
  /** Imported original (DOCX or PDF) in S3, when the draft started from a file. */
  sourceName?: string;
  sourceKey?: string;
};

/** JSON-serializable value; server functions reject `unknown`. */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

/** The Word body as stored in S3. */
export type WordDraftContent = {
  format: "tiptap";
  /** TipTap/ProseMirror document JSON. */
  doc: JsonValue;
  /** Plain text of the document, for the AI panel, search and word counts. */
  text: string;
};

export type DraftContent = WordDraftContent;

export type DraftDetail = DraftSummary & {
  content: DraftContent | null;
};

/** Words in a text snapshot; the same rule client and server. */
export function countWords(text: string): number {
  const trimmed = text.trim();
  if (!trimmed) return 0;
  return trimmed.split(/\s+/).length;
}

export function cleanDraftTitle(value: unknown): string {
  const title = typeof value === "string" ? value.replace(/\s+/g, " ").trim() : "";
  return title.slice(0, MAX_DRAFT_TITLE) || "Untitled document";
}
