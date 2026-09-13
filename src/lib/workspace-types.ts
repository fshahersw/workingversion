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
