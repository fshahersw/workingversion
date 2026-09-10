// ============================================================================
// Frontier research pipeline — shared state + I/O contracts (model-agnostic).
//
// The two-model design (Nemotron router + Grok orchestrator/writer) carries
// EXPLICIT pipeline state instead of asking one model to re-derive the plan
// every turn:
//
//   Request -> RoutePlan -> ResearchPlan -> EvidenceBundle
//           -> VerificationReport -> Writer
//
// These are types only: no runtime, no provider payloads, no model calls. Every
// stage reads/writes these shapes, which is what makes the pipeline testable and
// debuggable in isolation. Section numbers below refer to
// referenceforagentarchitecture.md (the design reference).
//
// Nothing here depends on a specific model, so this file is safe on both the
// server and (type-only) the client.
// ============================================================================

// ---------------------------------------------------------------------------
// §6.1 RequestContext — the normalized request the router sees.
// ---------------------------------------------------------------------------

export type ChatRole = "user" | "assistant";

export interface ChatMessage {
  role: ChatRole;
  content: string;
}

export interface AttachmentRef {
  name: string;
  kind: string;
  chars?: number;
  hasFullText?: boolean;
}

export interface ChoiceSelection {
  panelId: string;
  selected: string[];
}

/** User-selected mode. "auto" lets the router decide the latency class. */
export type UserMode = "auto" | "fast" | "deep";

export interface RequestContext {
  requestId: string;
  conversationId: string;
  userMessage: string;
  /** Injected so freshness reasoning and date math never rely on model memory. */
  currentDateIso: string;
  userMode?: UserMode;
  conversationSummary?: string;
  recentMessages: ChatMessage[];
  attachments?: AttachmentRef[];
  /** Set when this request resumes after a choice-panel selection (§34). */
  userSelection?: ChoiceSelection;
}

// ---------------------------------------------------------------------------
// Tool families + latency classes (§4).
// ---------------------------------------------------------------------------

/** Canonical tool families the router may select (§13 registry namespaces). */
export type ToolFamily =
  | "web"
  | "courtlistener"
  | "docketbird"
  | "govinfo"
  | "regulations"
  | "fda"
  | "clinicaltrials"
  | "sec"
  | "browser"
  | "compute"
  | "document";

/** RoutePlan-level complexity (three tiers the router assigns). */
export type Complexity = "fast" | "standard" | "deep";

/** Execution latency class (§4). ARTIFACT layers a document renderer on top of
 *  a STANDARD/DEEP evidence pipeline, so it is derived from the RoutePlan rather
 *  than emitted directly by the router. */
export type LatencyClass = "FAST" | "STANDARD" | "DEEP" | "ARTIFACT";

// ---------------------------------------------------------------------------
// §33 Choice panel — a native UI response primitive (the model emits structure,
// never HTML).
// ---------------------------------------------------------------------------

export type SelectionMode = "single" | "multiple";

export interface ChoiceOption {
  id: string;
  label: string;
  description?: string;
  value: string;
  recommended?: boolean;
}

export interface ChoicePanel {
  id: string;
  title: string;
  description?: string;
  selectionMode: SelectionMode;
  options: ChoiceOption[];
  allowOther?: boolean;
}

// ---------------------------------------------------------------------------
// §6.2 RoutePlan — the ONLY output expected from Nemotron. Small, structured,
// no prose, no tools.
// ---------------------------------------------------------------------------

export type RouteIntent =
  | "answer"
  | "rewrite"
  | "legal_research"
  | "docket_status"
  | "case_law"
  | "regulatory"
  | "citation_check"
  | "data_analysis"
  | "artifact"
  | "browser_task";

export type Freshness = "not_required" | "recent_preferred" | "current_required";

/** Grok reasoning effort the router requests for downstream turns (§2.2). */
export type GrokReasoning = "low" | "medium" | "high" | "xhigh";

export type AnswerStyle = "concise" | "normal" | "legal_memo" | "research_report" | "document";

export interface RoutePlan {
  intent: RouteIntent;
  complexity: Complexity;
  freshness: Freshness;

  needsTools: boolean;
  needsGrokPlanner: boolean;

  grokReasoning: GrokReasoning;

  toolFamilies: ToolFamily[];

  canParallelize: boolean;

  maxResearchRounds: number;

  needsChoicePanel: boolean;
  choicePanel?: ChoicePanel;

  answerStyle: AnswerStyle;

  /** Short machine-readable label, e.g. CURRENT_DOCKET_LOOKUP. Never prose. */
  rationaleCode: string;
}

// ---------------------------------------------------------------------------
// §9 OrchestratorDecision — the Grok orchestrator's per-round structured output.
// ---------------------------------------------------------------------------

export type OrchestratorStatus =
  | "tool_batch"
  | "complete"
  | "request_user_choice"
  | "handoff_to_writer";

export interface ToolCallSpec {
  /** Stable id used to wire parallelGroups and match results back. */
  id: string;
  /** Canonical tool name from the registry (§13), e.g. "courtlistener.search". */
  tool: string;
  args: Record<string, unknown>;
}

export interface OrchestratorDecision {
  status: OrchestratorStatus;
  calls?: ToolCallSpec[];
  /** Groups of call ids the runtime may execute concurrently (§29). */
  parallelGroups?: string[][];
  /** Requirement descriptions still unmet (drives the coverage matrix, §43). */
  missingElements?: string[];
  nextReasoningEffort?: GrokReasoning;
  choicePanel?: ChoicePanel;
  writerInstructions?: string[];
}

// ---------------------------------------------------------------------------
// §11 Evidence contract — every tool normalizes results into this before the
// writer sees them. §12 authority levels are encoded in frontier-authority.ts.
// ---------------------------------------------------------------------------

/** 1 = strongest (official primary), 5 = weakest (general web). See §12. */
export type AuthorityLevel = 1 | 2 | 3 | 4 | 5;

export type SourceType =
  | "court_filing"
  | "court_opinion"
  | "statute"
  | "regulation"
  | "agency"
  | "government"
  | "clinical_trial"
  | "sec_filing"
  | "news"
  | "secondary"
  | "web";

export interface EvidenceItem {
  id: string;

  sourceType: SourceType;
  /** The retrieval provider, e.g. "courtlistener", "agentcore-web-search". */
  provider: string;
  authorityLevel: AuthorityLevel;

  title: string;
  url: string;

  /** §50 source-date normalization: publication/filing date is separate from
   *  the underlying event/effective date. */
  publishedAt?: string;
  eventDate?: string;
  retrievedAt: string;

  court?: string;
  docketNumber?: string;
  caseName?: string;

  /** Short quoted/relevant span; raw source text stays outside model context. */
  excerpt?: string;
  /** Pointer (e.g. S3 ref) to the full retrieved source (§37). */
  textRef?: string;

  /** Content hash for dedup + integrity (§42/§23). */
  hash?: string;

  /** Requirement/proposition ids this item supports or contradicts. */
  supports: string[];
  contradicts: string[];

  primarySource: boolean;
  /** True when this changeable fact was freshly verified this request (§8.2). */
  currentVerified: boolean;

  confidence: number;
}

// ---------------------------------------------------------------------------
// §43 Coverage matrix + EvidenceBundle handed to verification/writer.
// ---------------------------------------------------------------------------

export type RequirementStatus = "missing" | "partial" | "verified" | "conflicted";

export interface ResearchRequirement {
  id: string;
  description: string;
  required: boolean;
  evidenceIds: string[];
  status: RequirementStatus;
}

export interface EvidenceBundle {
  items: EvidenceItem[];
  /** The coverage matrix, when the request ran the full research loop. */
  requirements?: ResearchRequirement[];
  /** Human-readable limitations to surface honestly to the writer (§57). */
  limitations?: string[];
}

/** Normalized result of executing one ToolCallSpec (§29 allSettled semantics:
 *  a failed call yields ok:false and never throws). */
export interface ToolRunResult {
  callId: string;
  tool: string;
  ok: boolean;
  evidence: EvidenceItem[];
  summary?: string;
  error?: string;
}

// ---------------------------------------------------------------------------
// §27.5 claim verification + §44 completeness gate report.
// ---------------------------------------------------------------------------

export type SupportStrength = "direct" | "partial" | "weak" | "contradicted";

export interface ClaimVerification {
  citationExists: boolean;
  propositionSupported: boolean;
  supportStrength: SupportStrength;
  sourceSpan?: string;
  notes?: string;
}

export interface VerificationReport {
  claims: ClaimVerification[];
  citationIntegrityPassed: boolean;
  currentFactsAreFresh: boolean;
  notes?: string[];
}

// ---------------------------------------------------------------------------
// §51 user-facing citation + §26 artifact reference.
// ---------------------------------------------------------------------------

export interface UiCitation {
  id: string;
  label: string;
  title: string;
  url: string;
  sourceType: string;
  publishedAt?: string;
  eventDate?: string;
  excerpt?: string;
}

export interface ArtifactRef {
  name: string;
  url?: string;
  format?: string;
  s3Ref?: string;
}

// ---------------------------------------------------------------------------
// §32 streaming protocol — the target event vocabulary the new path emits
// (short progress summaries, never raw chain-of-thought, §1.4). This maps onto
// the existing SSE emitter when the new path is wired in.
// ---------------------------------------------------------------------------

export type AgentStreamEvent =
  | { type: "request_started"; requestId: string }
  | { type: "route_selected"; mode: string; label: string }
  | { type: "analysis_status"; label: string }
  | { type: "tool_started"; tool: string; label: string }
  | { type: "tool_result"; tool: string; summary: string; sourceCount?: number }
  | { type: "verification_status"; label: string }
  | { type: "writer_started"; label: string }
  | { type: "text_delta"; delta: string }
  | { type: "citation"; citation: UiCitation }
  | { type: "choice_panel"; panel: ChoicePanel }
  | { type: "artifact_ready"; artifact: ArtifactRef }
  | { type: "completed" }
  | { type: "error"; recoverable: boolean; message: string };

// ---------------------------------------------------------------------------
// §35 conversation memory — the durable context carried between turns. The
// existing SessionMemory (memory.server) maps onto this shape.
// ---------------------------------------------------------------------------

export interface ActiveMatter {
  caseName?: string;
  docketNumber?: string;
  court?: string;
  providerIds?: Record<string, string>;
}

export interface ConversationMemory {
  rollingSummary: string;
  activeMatter?: ActiveMatter;
  confirmedUserChoices: Record<string, string>;
  recentMessages: ChatMessage[];
}
