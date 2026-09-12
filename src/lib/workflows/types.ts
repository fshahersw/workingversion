export type StepKind =
  | "trigger"
  | "files"
  | "text"
  | "selection"
  | "prompt"
  | "agent"
  | "extract"
  | "table"
  | "compare"
  | "citations"
  | "search"
  | "condition"
  | "review"
  | "foreach"
  | "merge"
  | "delay"
  | "document"
  | "edit"
  | "response"
  | "notify"
  | "python"
  | "mcp"
  | "recipe"
  | "web"
  | "scrape";
export type StepConfig = {
  instructions?: string;
  model?: string;
  context?: string[];
  fields?: string[];
  left?: string;
  operator?: "contains" | "equals" | "is_true" | "greater_than" | "exists";
  right?: string;
  reviewer?: string;
  format?: "docx" | "pdf" | "txt" | "csv";
  filename?: string;
  options?: string[];
  value?: string;
  connection?: string;
  tool?: string;
  code?: string;
  seconds?: number;
  recipients?: string[];
  query?: string;
  recipe?: string;
  url?: string;
};
export type WorkflowStep = {
  id: string;
  type: "step";
  position: { x: number; y: number };
  data: { kind: StepKind; label: string; output: string; config: StepConfig };
};
export type WorkflowEdge = {
  id: string;
  source: string;
  target: string;
  sourceHandle?: string | null;
  targetHandle?: string | null;
  label?: string;
};
export type Schedule = {
  inputRunId?: string;
  enabled: boolean;
  frequency: "daily" | "weekly";
  time: string;
  timezone: string;
  days: number[];
  nextRun?: string;
  lastRun?: string;
  lastError?: string;
  lastErrorAt?: string;
  retryAt?: string;
};
export type Sharing = {
  visibility: "private" | "teams";
  teams: string[];
  permission: "view" | "run" | "edit";
};
export type Workflow = {
  revision?: number;
  ownerId?: string;
  access?: "owner" | "edit" | "run" | "view";
  publishedApp?: MiniAppSpec;
  schemaVersion: 1;
  id: string;
  name: string;
  description: string;
  category: string;
  nodes: WorkflowStep[];
  edges: WorkflowEdge[];
  updatedAt: string;
  createdBy: string;
  version: number;
  publishedAt?: string;
  publishedGraph?: { nodes: WorkflowStep[]; edges: WorkflowEdge[] };
  dirty?: boolean;
  schedule: Schedule;
  sharing: Sharing;
  app?: MiniAppSpec;
};
export type AppField = {
  id: string;
  label: string;
  type: "text" | "textarea" | "select" | "date" | "url";
  required: boolean;
  options?: string[];
  value?: string;
};
export type MiniAppSpec = {
  templateId?: string;
  description: string;
  autoRunOnUpload: boolean;
  fields: AppField[];
};
export type EvidenceRow = {
  id: string;
  cells: Record<string, string>;
  source: string;
  line: number;
  excerpt: string;
  status: "Review" | "Found" | "Missing" | "Changed";
  sourceId?: string;
  page?: number;
  endLine?: number;
  references?: EvidenceReference[];
};
export type EvidenceReference = {
  sourceId: string;
  source: string;
  line: number;
  endLine?: number;
  page?: number;
  excerpt: string;
};
export type AnalysisReport = {
  type: "analysis-report";
  title: string;
  summary: string;
  columns: string[];
  rows: EvidenceRow[];
  notes: string[];
  text: string;
  coverage?: {
    documents: number;
    characters: number;
    totalRows: number;
    shownRows: number;
    warnings: string[];
  };
};
export type SourceFile = {
  id: string;
  name: string;
  text: string;
  size: number;
  metadata?: {
    format: string;
    sha256?: string;
    pages?: number;
    warnings: string[];
    extractedAt?: string;
  };
};
export type RunInputs = {
  text: string;
  matter: string;
  selection: string;
  files: SourceFile[];
  fields?: Record<string, string>;
};
export type RunStatus = "running" | "waiting" | "completed" | "failed" | "cancelled" | "rejected";
export type StepStatus = "pending" | "running" | "completed" | "skipped" | "waiting" | "failed";
export type StepResult = {
  status: StepStatus;
  output?: unknown;
  startedAt?: string;
  endedAt?: string;
  error?: string;
  resumeAt?: string;
};
export type RunLog = {
  id: string;
  time: string;
  nodeId?: string;
  message: string;
  level: "info" | "success" | "warning" | "error";
};
export type Artifact = {
  id: string;
  name: string;
  format: "docx" | "pdf" | "txt" | "csv";
  content: string;
  nodeId: string;
};
export type WorkflowRun = {
  usage?: { input: number; output: number; requests: number };
  id: string;
  workflowId: string;
  workflowName: string;
  version: number;
  graph: { nodes: WorkflowStep[]; edges: WorkflowEdge[] };
  status: RunStatus;
  startedAt: string;
  endedAt?: string;
  inputs: RunInputs;
  results: Record<string, StepResult>;
  logs: RunLog[];
  artifacts: Artifact[];
  mode: "local" | "connected";
  source: "manual" | "schedule";
};
export type ValidationIssue = {
  severity: "error" | "warning";
  message: string;
  nodeId?: string;
};
export type ExecutionContext = {
  inputs: RunInputs;
  values: Record<string, unknown>;
  files: SourceFile[];
  signal?: AbortSignal;
};
export type ExecutionResult = {
  output: unknown;
  artifacts?: Omit<Artifact, "id" | "nodeId">[];
};
export type WorkflowAdapter = {
  /** Return false for locally implemented steps; avoids routing every action to the host. */
  canExecute?: (step: WorkflowStep) => boolean;
  /** Host-owned authorization. Tokens must remain on the host server. */
  connect?: (connectionId: string) => Promise<{ connected: boolean; account?: string }>;
  connections?: { id: string; connected: boolean; account?: string }[];
  /** Server-backed execution for AI, Python, or MCP. Never put credentials in step configuration. */
  executeStep?: (step: WorkflowStep, context: ExecutionContext) => Promise<ExecutionResult>;
  /** Persist or enforce permissions in the host platform. Local sharing is metadata only. */
  onShare?: (workflow: Workflow) => Promise<void>;
  onPublish?: (workflow: Workflow) => Promise<void>;
  onSchedule?: (workflow: Workflow) => Promise<void>;
};
export type WorkflowsPageProps = {
  /** Fill an existing application shell and omit the standalone brand header. */
  embedded?: boolean;
  workspaceName?: string;
  currentUser?: { name: string; initials: string };
  initialWorkflows?: Workflow[];
  initialWorkflowId?: string;
  storageKey?: string;
  adapter?: WorkflowAdapter;
  useHashRouting?: boolean;
  onChange?: (workflows: Workflow[]) => void;
};
