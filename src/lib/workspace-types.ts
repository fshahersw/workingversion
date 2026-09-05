// Client-safe DTO types for the corpus v2 matter workspace.

export type MatterListItem = {
  matterId: string;
  slug: string;
  shortName: string;
  caseName: string;
  docketNumber: string;
  courtId: string;
  courtName: string | null;
  judge: string | null;
  status: string | null;
  stage: string | null;
  mdlNumber: string | null;
  pipelineStage: string;
  verifiedAt: string | null;
  entries: number;
  documents: number;
  withPdf: number;
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

export type DocketSource = "main" | "jpml";

export type WorkspaceEntry = {
  id: string;
  entryNumber: number;
  entryLabel: string;
  docketSource: DocketSource;
  dateFiled: string | null;
  description: string;
  entryType: string | null;
  pageCount: number | null;
  documentCount: number;
  hasPdf: boolean;
};

export type WorkspaceDocument = {
  id: string;
  entryNumber: number | null;
  entryLabel: string;
  docketSource: DocketSource;
  attachmentNumber: number;
  title: string;
  docType: string | null;
  byteCount: number | null;
  pageCount: number | null;
  hasPdf: boolean;
  isSealed: boolean;
  textStatus: string;
};

export type MatterWorkspace = {
  matter: MatterListItem;
  parties: WorkspaceParty[];
  counsel: WorkspaceCounsel[];
  typeFacets: { type: string; count: number }[];
  dateRange: { first: string | null; last: string | null };
};

export type EntryQuery = {
  slug: string;
  search?: string;
  types?: string[];
  onlyWithPdf?: boolean;
  docket?: DocketSource;
  sort?: "entry-desc" | "entry-asc" | "date-desc" | "date-asc";
  offset?: number;
  limit?: number;
};

export type EntriesPage = { rows: WorkspaceEntry[]; total: number };

export type DocumentQuery = {
  slug: string;
  search?: string;
  types?: string[];
  onlyWithPdf?: boolean;
  docket?: DocketSource;
  sort?: "entry-desc" | "entry-asc";
  offset?: number;
  limit?: number;
};


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
