// ============================================================================
// Writer documents: shared types (client + server).
//
// A Writer document is an owner-scoped Library row (ITEM#<draftId>, type
// "draft", kind "docx") whose body is a real DOCX kept in S3 as immutable,
// content-addressed revisions:
//   drafts/<principal>/<draftId>/r<version>-<sha256>.docx
// plus an optional crash-recovery copy (recovery.docx). Saves carry the
// revision the client loaded (If-Match) and an idempotency key so a retried
// save never creates a second revision.
// ============================================================================

export const DRAFT_ID = /^[0-9A-HJKMNP-TV-Z]{26}$/;
export const SHA256_HEX = /^[0-9a-f]{64}$/;
export const IDEMPOTENCY_KEY = /^[A-Za-z0-9_-]{8,100}$/;

/** Largest DOCX accepted for upload or save. */
export const MAX_DOCX_BYTES = 30 * 1024 * 1024;
/** Revisions kept per document before saves are refused. */
export const MAX_REVISIONS = 200;
/** Total bytes across all revisions of one document. */
export const MAX_REVISION_BYTES = 256 * 1024 * 1024;
/** Documents per user (soft cap, matches the Office preview). */
export const MAX_DOCS_PER_USER = 500;
export const MAX_DOC_NAME = 160;

export const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

export type WriterRevision = {
  version: number;
  hash: string;
  size: number;
  createdAt: string;
};

export type WriterDocSummary = {
  draftId: string;
  kind: "docx";
  /** Display name, always ending in .docx. */
  name: string;
  /** Name without the .docx extension (Library and page titles). */
  title: string;
  folderId: string;
  /** Current revision number (1 = as created). */
  version: number;
  /** sha256 of the current revision. */
  hash: string;
  /** Bytes of the current revision. */
  size: number;
  createdAt: string;
  updatedAt: string;
  /** A recovery copy newer than the current revision exists. */
  recovery: { at: string } | null;
};

export type WriterDocDetail = WriterDocSummary & {
  revisions: WriterRevision[];
};

/** One persisted assistant-panel message (mirrors project-store ChatMessage). */
export type WriterChatMessage = {
  seq: number;
  ts: string;
  role: "user" | "assistant";
  text: string;
  tools?: Array<{
    name: string;
    summary: string;
    isError?: boolean;
    input?: string;
    output?: string;
  }>;
  attachments?: Array<{ name: string; path?: string; ext?: string; sizeBytes?: number }>;
};

/** Normalize a user-supplied document name to a safe `<stem>.docx`. */
export function cleanDocName(value: unknown, fallback = "Untitled.docx"): string {
  const raw = typeof value === "string" ? value : "";
  let name = raw
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x1f<>:"/\\|?*]/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_DOC_NAME);
  if (!name || /^\.+$/.test(name)) name = fallback;
  if (!/\.docx$/i.test(name)) name = `${name}.docx`;
  return name;
}

export function titleOf(name: string): string {
  return name.replace(/\.docx$/i, "") || "Untitled";
}

export function isDraftId(value: unknown): value is string {
  return typeof value === "string" && DRAFT_ID.test(value);
}
