// ============================================================================
// Office documents: shared types (client + server) for every editor kind.
//
// An Office document is an owner-scoped Library row (ITEM#<docId>, type
// "draft", kind "docx" | "xlsx" | "pptx") whose body is kept in S3 as immutable,
// content-addressed revisions:
//   drafts/<principal>/<docId>/r<version>-<sha256>.<ext>
// plus an optional crash-recovery copy (recovery.<ext>). Saves carry the
// revision the client loaded (If-Match) and an idempotency key so a retried
// save never creates a second revision. The Writer's types re-export the
// docx view of this model.
// ============================================================================

export const DOC_ID = /^[0-9A-HJKMNP-TV-Z]{26}$/;
export const SHA256_HEX = /^[0-9a-f]{64}$/;
export const IDEMPOTENCY_KEY = /^[A-Za-z0-9_-]{8,100}$/;

export type OfficeKind = "docx" | "xlsx" | "pptx" | "pdf";
export const OFFICE_KINDS: readonly OfficeKind[] = ["docx", "xlsx", "pptx", "pdf"];

export function isOfficeKind(value: unknown): value is OfficeKind {
  return value === "docx" || value === "xlsx" || value === "pptx" || value === "pdf";
}

export const OFFICE_MIME: Record<OfficeKind, string> = {
  pdf: "application/pdf",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
};

/** The OOXML main-part folder each kind must contain. */
export const OFFICE_MAIN_PART: Record<Exclude<OfficeKind, "pdf">, string> = {
  docx: "word/",
  xlsx: "xl/",
  pptx: "ppt/",
};

export const OFFICE_LABEL: Record<OfficeKind, string> = {
  pdf: "PDF document",
  docx: "Word document",
  xlsx: "Excel workbook",
  pptx: "PowerPoint deck",
};

/** Which editor app (and assistant tool policy) serves each kind. */
export const OFFICE_APP: Record<OfficeKind, "writer" | "sheets" | "slides" | "pdf"> = {
  pdf: "pdf",
  docx: "writer",
  xlsx: "sheets",
  pptx: "slides",
};

/** Largest package accepted for upload or save. */
export const MAX_OFFICE_BYTES = 30 * 1024 * 1024;
/** Revisions kept per document before saves are refused. */
export const MAX_REVISIONS = 200;
/** Total bytes across all revisions of one document. */
export const MAX_REVISION_BYTES = 256 * 1024 * 1024;
/** Documents per user (soft cap). */
export const MAX_DOCS_PER_USER = 500;
export const MAX_DOC_NAME = 160;

export type OfficeRevision = {
  version: number;
  hash: string;
  size: number;
  createdAt: string;
};

export type OfficeDocSummary = {
  draftId: string;
  kind: OfficeKind;
  /** Display name, always ending in the kind's extension. */
  name: string;
  /** Name without the extension (Library and page titles). */
  title: string;
  folderId: string;
  /** Current revision number (1 = as created; 0 = legacy draft not yet converted). */
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

export type OfficeDocDetail = OfficeDocSummary & {
  revisions: OfficeRevision[];
};

/** One persisted assistant-panel message (mirrors project-store ChatMessage). */
export type OfficeChatMessage = {
  seq: number;
  ts: string;
  role: "user" | "assistant";
  text: string;
  tools?: Array<{
    name: string;
    summary: string;
    isError?: boolean;
    skipped?: boolean;
    input?: string;
    output?: string;
  }>;
  attachments?: Array<{ name: string; path?: string; ext?: string; sizeBytes?: number }>;
};

// eslint-disable-next-line no-control-regex
const CONTROL_AND_RESERVED = /[\u0000-\u001f<>:"/\\|?*]/g;

/** Normalize a user-supplied document name to a safe `<stem>.<ext>` for the kind. */
export function cleanOfficeName(
  kind: OfficeKind,
  value: unknown,
  fallbackStem = "Untitled",
): string {
  const raw = typeof value === "string" ? value : "";
  let name = raw
    .replace(CONTROL_AND_RESERVED, "_")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_DOC_NAME);
  // Drop any Office extension the user typed, then add the right one.
  name = name.replace(/\.(docx|xlsx|xlsm|csv|doc|xls|pptx|pptm|ppt|pdf)$/i, "");
  if (!name || /^\.+$/.test(name)) name = fallbackStem;
  return `${name}.${kind}`;
}

export function titleOf(name: string): string {
  return name.replace(/\.(docx|xlsx|pptx|pdf)$/i, "") || "Untitled";
}

export function isDocId(value: unknown): value is string {
  return typeof value === "string" && DOC_ID.test(value);
}
