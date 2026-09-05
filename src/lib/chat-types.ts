export type AgentKey =
  | "statutes_regulations"
  | "agency_guidance"
  | "case_law"
  | "visa_bulletin_data"
  | "web_search"
  | "legal_research"
  | "docket_research"
  | "research"
  | "router"
  | "writer";

export const AGENT_META: Record<
  AgentKey,
  { name: string; color: string; soft: string; ring: string }
> = {
  statutes_regulations: {
    name: "Statutes & Regulations",
    color: "text-brand-navy",
    soft: "bg-[oklch(0.96_0.03_262)]",
    ring: "ring-[oklch(0.55_0.22_262/0.3)]",
  },
  agency_guidance: {
    name: "Agency Guidance",
    color: "text-teal-700",
    soft: "bg-teal-50",
    ring: "ring-teal-200",
  },
  case_law: {
    name: "Case Law",
    color: "text-purple-700",
    soft: "bg-purple-50",
    ring: "ring-purple-200",
  },
  visa_bulletin_data: {
    name: "Visa Bulletin Data",
    color: "text-amber-700",
    soft: "bg-amber-50",
    ring: "ring-amber-200",
  },
  web_search: {
    name: "Open Web Research",
    color: "text-slate-700",
    soft: "bg-slate-100",
    ring: "ring-slate-300",
  },
  legal_research: {
    name: "Authoritative Research",
    color: "text-brand-navy",
    soft: "bg-slate-100",
    ring: "ring-slate-300",
  },
  docket_research: {
    name: "Docket & Filings",
    color: "text-purple-700",
    soft: "bg-purple-50",
    ring: "ring-purple-200",
  },
  research: {
    name: "Litigation Analyst",
    color: "text-brand-navy",
    soft: "bg-brand-blue-soft/60",
    ring: "ring-[oklch(0.55_0.22_262/0.3)]",
  },
  router: {
    name: "Orchestrator",
    color: "text-brand-navy",
    soft: "bg-slate-50",
    ring: "ring-slate-200",
  },
  writer: {
    name: "Legal Writer",
    color: "text-brand-orange",
    soft: "bg-brand-orange-soft",
    ring: "ring-orange-200",
  },
};

export function agentMeta(k: string) {
  return (
    AGENT_META[k as AgentKey] ?? {
      // Title-case unknown agent keys (e.g. "research" -> "Research") so the
      // timeline never shows a raw snake_case id.
      name: k.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()),
      color: "text-brand-navy",
      soft: "bg-brand-blue-soft/60",
      ring: "ring-[oklch(0.55_0.22_262/0.3)]",
    }
  );
}

/** Plain-English display names for the research tools. */
const TOOL_LABELS: Record<string, string> = {
  search_case_law: "Case Law & Dockets",
  search_regulatory_text: "Regulatory Text",
  search_enforcement_history: "Enforcement History",
  search_scientific_literature: "Scientific Literature",
  search_technical_environmental: "Technical & Environmental",
  search_judicial_parties: "Judicial & Parties",
  search_legal_news: "Legal News",
  db_search_filings: "Docket Search",
  db_read_filing: "Filing Text",
  db_get_case: "Case Lookup",
  search_authorities: "Authority Sweep",
  db_find_case: "Find Case",
  db_docket_sheet: "Docket Sheet",
  db_calendar: "Case Calendar",
  db_graph_ask: "Litigation Graph",
  fetch_page: "Reading Page",
  recap_search: "RECAP Search",
  recap_docket: "RECAP Docket",
  recap_read: "Reading Filing",
};

const WEB_SCOPE_LABELS: Record<string, string> = {
  primary: "Authority Sweep",
  analysis: "Deep Background",
  news: "Litigation Wire",
};

export function toolLabel(tool: string, scope?: string): string {
  if (tool === "web_search")
    return WEB_SCOPE_LABELS[scope ?? "primary"] ?? "Authority Sweep";
  return (
    TOOL_LABELS[tool] ??
    tool.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase())
  );
}

export type ToolCall = {
  /** Bedrock tool-use id — stable across the call's start + completion emits,
   *  so the client upserts one row instead of appending two. */
  id?: string;
  tool: string;
  query?: string;
  scope?: string;
  hits?: number;
};

export type AgentRun = {
  agent: string;
  focus: string;
  status: "running" | "done";
  tools: ToolCall[];
  summary?: string;
  count?: number;
  citations?: string[];
};

export type Round = {
  round: number;
  /** Short model-written status phrase, e.g. "Locating The Docket". */
  phase?: string;
  reasoning: string;
  scratch_note?: string;
  done?: boolean;
  dispatch: { agent: string; focus: string }[];
  agents: Record<string, AgentRun>;
};

export type Source = {
  ref: string;
  citation: string;
  authority: string;
  source_type: string;
  section_path?: string;
  source_url?: string;
  effective_date?: string;
  is_current?: boolean;
  /** Site favicon URL when the retrieval provider supplied one (Tavily). */
  favicon?: string;
  /** Provider relevance score (0-1) when available. */
  relevance?: number;

  content: string;
};

/** A file or chart produced by the code interpreter (run_python), surfaced in
 *  the chat for inline display (charts) or download (created files). */
export type Artifact = {
  /** Stable id within a message — used for React keys and upsert dedupe. */
  id: string;
  kind: "image" | "file";
  name: string;
  /** MIME type, e.g. "image/png", "application/vnd.openxmlformats-...". */
  mime: string;
  /** base64 payload, inlined for small artifacts. Absent when the file was too
   *  large to inline (then only name/size render, download deferred). */
  dataB64?: string;
  /** Decoded byte size, when known. */
  size?: number;
};

export type Message = {
  id: string;
  role: "user" | "assistant";
  text: string;
  rounds: Round[];
  sources: Source[];
  answer: string;
  /** Charts + files produced by run_python during this turn. */
  artifacts?: Artifact[];
  /** Live, streamed research narration ("thinking steps") shown before the answer. */
  thinking?: string;
  /** The model's actual adaptive-thinking reasoning, streamed live (frontier feel). */
  reasoning?: string;
  status: "thinking" | "writing" | "done" | "error";
  error?: string;
  collapseTimeline?: boolean;
  followups?: string[];
  /** Deterministic citation/fact verification computed after synthesis. */
  verification?: {
    factsChecked: number;
    factsVerified: number;
    unverified: string[];
    orphanRefs: string[];
  };
};

/** Matter the research session is scoped to (null = global research). */
export type MatterScope = {
  matterId: string;
  label: string;
};
