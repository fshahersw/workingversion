// Client-safe DTO types for the matters workspace (Aurora `corpus.*` schema).

/** Where a docket sits in the litigation. */
export type DocketScope = "federal" | "jpml" | "member" | "state" | "appellate";

export const DOCKET_SCOPES: DocketScope[] = ["federal", "jpml", "member", "state", "appellate"];

export type ScopeCounts = Record<DocketScope, { dockets: number; files: number }>;

export type MatterListItem = {
  matterId: string;
  slug: string;
  shortName: string;
  caseName: string;
  mdlNumber: string | null;
  /** Lead (transferee) docket. */
  docketNumber: string;
  courtId: string;
  courtName: string | null;
  judge: string | null;
  /** Distinct (docket, entry) pairs with at least one file row. */
  entries: number;
  /** Total file rows (attachments included). */
  documents: number;
  /** File rows with a stored PDF. */
  withPdf: number;
  sealed: number;
  scopeCounts: ScopeCounts;
  /** Most recent docket sync across the matter (ISO), or null. */
  lastSyncedAt: string | null;
};

export type WorkspaceDocket = {
  docketId: string;
  scope: DocketScope;
  courtId: string;
  docketNumber: string;
  title: string | null;
  isLead: boolean;
  /** Entries on the docket sheet (from the source), not just entries we hold files for. */
  entryCount: number;
  filesPresent: number;
  pdfAvailable: number;
  sealedCount: number;
  missingCount: number;
  completionPct: number | null;
  /** Firm follows this docket in DocketBird, so it receives automatic updates. */
  followed: boolean;
  lastSyncedAt: string | null;
  /** Assigned / referred judge as recorded on the docket (CourtListener), or null. */
  assignedJudge: string | null;
  referredJudge: string | null;
};

// ---- Court reference layer (reference.* schema: registry, identity assets,
// ---- per-court rules, standing orders and forms from the firm's document library).

export type CourtIdentity = {
  /** Reference-library key, e.g. "FD:njd". */
  key: string;
  name: string;
  level: string;
  jurisdiction: string;
  website: string | null;
  formsPages: string[];
  /** Presigned URL of the court mark, or null when the library holds none. */
  logoUrl: string | null;
  logoKind: string | null;
  /** Background the mark was published on ("light" | "dark"). */
  logoBackground: "light" | "dark" | null;
  fallbackText: string;
  reuseNote: string | null;
  /** Documents the library holds for this court, by kind. */
  resourceCounts: Record<CourtResourceKind, number>;
};

export type JudgeIdentity = {
  name: string;
  courtKey: string;
  /** Presigned portrait URL; only shown when the docket names this judge. */
  portraitUrl: string | null;
  sourcePage: string | null;
  role: "assigned" | "referred";
};

export type CourtResourceKind =
  | "standing_order"
  | "local_rule"
  | "form"
  | "instruction"
  | "order"
  | "other";

export const COURT_RESOURCE_KINDS: CourtResourceKind[] = [
  "standing_order",
  "local_rule",
  "form",
  "instruction",
  "order",
  "other",
];

export type CourtResource = {
  sha256: string;
  title: string;
  kind: CourtResourceKind;
  format: "pdf" | "docx" | "doc" | "rtf";
  bytes: number | null;
  pageCount: number | null;
  sourceUrl: string | null;
  sourceDate: string | null;
  sourceDateKind: string | null;
  reviewStatus: string | null;
  fillable: boolean;
  /** Judge named in a standing order's title, when one is. */
  judgeName: string | null;
  /** Portrait of that judge when the library has an official one for this court. */
  judgePortraitUrl: string | null;
  courtKey: string | null;
};

export type CourtResourceQuery = {
  /** Reference keys to search, most specific first (courtReferenceKeys). */
  courtKeys: string[];
  kind?: CourtResourceKind;
  /** "word" narrows to DOCX/DOC/RTF templates; "pdf" to PDFs. */
  format?: "word" | "pdf";
  search?: string;
  page?: number;
  pageSize?: number;
};

export type CourtResourcePage = {
  total: number;
  page: number;
  pageSize: number;
  items: CourtResource[];
};

export type WorkspaceParty = {
  id: string;
  name: string;
  partyType: string | null;
};

export type WorkspaceCounsel = {
  id: string;
  attorney: string;
  firm: string | null;
  role: string | null;
  partyName: string | null;
};

export type WorkspaceEntry = {
  /** "<docket_id>:<entry_number>" */
  id: string;
  docketId: string;
  scope: DocketScope;
  courtId: string;
  docketNumber: string;
  entryNumber: number;
  entryLabel: string;
  dateFiled: string | null;
  /** True when the date is the docket's filing date, not this entry's own date. */
  dateApprox: boolean;
  description: string;
  entryType: string | null;
  pageCount: number | null;
  documentCount: number;
  pdfCount: number;
  sealedCount: number;
  hasPdf: boolean;
};

export type WorkspaceDocument = {
  id: string;
  docketId: string;
  scope: DocketScope;
  courtId: string;
  docketNumber: string;
  entryNumber: number | null;
  entryLabel: string;
  attachmentNumber: number;
  title: string;
  docType: string | null;
  dateFiled: string | null;
  dateApprox: boolean;
  byteCount: number | null;
  pageCount: number | null;
  hasPdf: boolean;
  isSealed: boolean;
  source: string | null;
};

export type MatterWorkspace = {
  matter: MatterListItem;
  dockets: WorkspaceDocket[];
  parties: WorkspaceParty[];
  counsel: WorkspaceCounsel[];
  typeFacets: { type: string; count: number }[];
  dateRange: { first: string | null; last: string | null };
  /** Identity and library coverage for the lead docket's court, or null when unknown. */
  court: CourtIdentity | null;
  /** Judges named on the lead docket that the library can identify (portraits optional). */
  judges: JudgeIdentity[];
};

export type LedgerSort = "date-desc" | "date-asc" | "entry-desc" | "entry-asc";

export type LedgerFilter = {
  slug: string;
  search?: string;
  types?: string[];
  scope?: DocketScope;
  docketId?: string;
  /** ISO date (YYYY-MM-DD) inclusive bounds. */
  dateFrom?: string;
  dateTo?: string;
  onlyWithPdf?: boolean;
  hideSealed?: boolean;
  sort?: LedgerSort;
  offset?: number;
  limit?: number;
};

export type EntryQuery = LedgerFilter;
export type DocumentQuery = LedgerFilter;

export type EntriesPage = { rows: WorkspaceEntry[]; total: number };
export type DocumentsPage = { rows: WorkspaceDocument[]; total: number };

export type PipelineRun = {
  id: string;
  slug: string;
  stage: string;
  status: string;
  startedAt: string | null;
  finishedAt: string | null;
  /** JSON-serialized run detail payload (null when absent). */
  detail: string | null;
};
