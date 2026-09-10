# Frontier Legal Agent — Routing, Tooling, Streaming & Prompting Reference

**Status:** Implementation reference  
**Last verified:** 2026-09-09  
**Primary platform:** AWS Bedrock + Amazon Bedrock AgentCore  
**Primary models:** NVIDIA Nemotron 3 Super 120B (fast router) + xAI Grok 4.6 (orchestrator/researcher/writer)  
**Current scope:** External/public research tools, code execution, browser fallback, file creation, tool orchestration, streaming UX  
**Deferred:** Firm-internal matter retrieval, permission-aware RAG, internal knowledge graph, DMS/Litify/SharePoint/iManage integrations

---

## 0. Executive decision

Use a **two-model dynamic routing architecture**:

1. **Nemotron 3 Super** handles almost every request first.
   - Intent classification
   - Complexity estimation
   - Tool-family selection
   - Parallelization plan
   - Fast-path vs deep-path decision
   - Whether a user choice is actually required
   - Whether Grok should receive the request immediately
   - Very short structured output only

2. **Grok 4.6** handles:
   - Complex legal research planning
   - Tool calling when legal judgment is needed
   - Multi-round research
   - Gap analysis
   - Conflicting evidence
   - Source hierarchy / authority judgment
   - Final answer synthesis
   - High-quality legal prose
   - Long-form drafting

3. **Application code controls execution.**
   - The model determines *what should happen*.
   - The runtime determines *how to execute it efficiently*.
   - Parallel work is executed concurrently by code.
   - Retries, timeouts, circuit breakers, caching and hard limits are deterministic.
   - The model does not get unlimited autonomous loops.

This should feel like a frontier chat product while remaining suitable for a latency-sensitive law-firm environment.

---

# 1. Architecture principles

## 1.1 Accuracy and latency are co-equal requirements

Do **not** optimize for maximum agent autonomy.

Optimize for:

```text
correct source
+ correct tool
+ minimum required calls
+ parallel execution
+ aggressive cache reuse
+ bounded research loops
+ immediate streaming feedback
```

The fastest legal agent is not the one with the fastest LLM alone. It is the one that avoids unnecessary LLM and network round trips.

---

## 1.2 Prefer deterministic sources before generic browsing

Default source order:

```text
Known structured legal/government API
        ↓
Known official MCP
        ↓
AgentCore Web Search
        ↓
Direct HTTP fetch
        ↓
AgentCore Browser
```

Do not use browser automation when an API or normal HTTP request will work.

---

## 1.3 Separate routing intelligence from writing intelligence

Do not ask the final writer to rediscover the entire execution plan.

Create explicit pipeline state:

```text
Request
  ↓
RoutePlan
  ↓
ResearchPlan (only if needed)
  ↓
EvidenceBundle
  ↓
VerificationReport
  ↓
Writer
```

This makes the system faster, testable and easier to debug.

---

## 1.4 Do not expose raw chain-of-thought

The UI may show a frontier-style execution timeline, but it should stream **short progress summaries**, not private reasoning.

Good:

```text
Searching federal docket…
Found the relevant MDL.
Checking the latest case-management order…
Comparing two potentially conflicting sources…
Drafting answer…
```

Bad:

```text
Here is my full hidden reasoning and every inference I am making...
```

For Grok Responses API calls, encrypted reasoning state may be retained server-side and passed back on later turns if desired. Treat it as opaque model state. Do not render it.

---

# 2. Current Bedrock model configuration

## 2.1 Nemotron 3 Super

AWS model ID:

```text
nvidia.nemotron-super-3-120b
```

Recommended endpoint for router:

```text
https://bedrock-runtime.us-east-1.amazonaws.com
```

Recommended API:

```text
Bedrock Converse / ConverseStream
```

AWS currently recommends `bedrock-runtime` when possible for new Nemotron applications.

Current AWS-documented characteristics:

```text
Context: 256K
Maximum output: 32K
Structured outputs: supported on bedrock-runtime
Streaming: supported
Priority tier: supported
Flex tier: supported
```

Current US East / Ohio / Oregon standard pricing:

```text
Input:  $0.15 / 1M tokens
Output: $0.65 / 1M tokens
```

Priority tier is currently documented at a 75% premium to Standard.

### Router recommendation

Start with:

```text
service_tier = default
```

Benchmark real production p50/p95.

If router latency materially affects UX, test:

```text
service_tier = priority
```

Because the router output is tiny, Priority can remain inexpensive even with its premium.

### Router generation constraints

```text
max_output_tokens: 250–500
temperature: 0–0.2
structured output: REQUIRED
```

The router should never produce prose for the end user.

---

## 2.2 Grok 4.6

Core model ID:

```text
xai.grok-4.6
```

AWS `bedrock-runtime` US cross-region inference ID:

```text
us.xai.grok-4.6
```

AWS global inference ID:

```text
global.xai.grok-4.6
```

Bedrock Mantle endpoint:

```text
https://bedrock-mantle.us-west-2.api.aws/openai/v1
```

Current AWS model-card behavior:

### `bedrock-runtime`

Supports:

```text
Responses
Chat Completions
Converse
response streaming
prompt caching
reasoning
```

Current model card does **not** list structured outputs or server-side tool use on `bedrock-runtime`.

### `bedrock-mantle`

Supports:

```text
Responses / Chat Completions
client-side tool calling
structured outputs
reasoning
response streaming
prompt caching
```

### Recommendation for this architecture

For **Grok as an actual tool-calling orchestrator**, prefer the Mantle path because client-side tool calling and structured outputs are explicitly documented there.

Keep your application/runtime in `us-east-1` because AgentCore Web Search currently requires `us-east-1`. Calling Grok Mantle in `us-west-2` creates one cross-region model hop, but avoids moving all tools and orchestration out of the region where the search connector resides.

Benchmark both paths in your AWS account before final production lock-in.

### Grok reasoning effort policy

```text
low     → ordinary answer / rewrite / simple synthesis
medium  → standard legal research or multi-source synthesis
high    → difficult legal analysis, ambiguity, conflicting sources
xhigh   → explicit deep research only; never default interactive mode
```

The router chooses the effort.

### Grok pricing currently documented by AWS

Standard:

```text
In-region:  $2.20 input / $6.60 output per 1M
US Geo:     $2.20 input / $6.60 output per 1M
Global:     $2.00 input / $6.00 output per 1M
```

For confidential firm workloads, prefer geography-appropriate routing over the lowest possible global price.

**Important:** AWS documentation has recently changed around service-tier availability for Grok. The current Grok 4.6 model card should be treated as the authority at deployment time. Do not hard-code Priority/Flex assumptions for Grok without verifying your account/model card.

---

# 3. Target request lifecycle

```text
┌───────────────────────────────────────────────┐
│ User message                                  │
└───────────────────────────┬───────────────────┘
                            │
                            ▼
┌───────────────────────────────────────────────┐
│ Request normalizer                            │
│ - conversation state                          │
│ - current date/time                           │
│ - attachments metadata                        │
│ - user-selected mode                          │
└───────────────────────────┬───────────────────┘
                            │
                            ▼
┌───────────────────────────────────────────────┐
│ NEMOTRON ROUTER                               │
│ Output: RoutePlan JSON                        │
└─────────────┬──────────────────┬──────────────┘
              │                  │
      simple / no tools      ambiguity matters
              │                  │
              ▼                  ▼
         GROK WRITER        CHOICE PANEL
              │                  │
              │              user selection
              │                  │
              └──────────┬───────┘
                         │
                 research required
                         │
                         ▼
               GROK ORCHESTRATOR
                         │
                         ▼
                  ToolCallBatch
                         │
            ┌────────────┼────────────┐
            ▼            ▼            ▼
         Court API   Web Search   Gov API...
            └────────────┼────────────┘
                         │
                         ▼
                   EvidenceBundle
                         │
                         ▼
                 Grok gap check
                    /         \
                complete    incomplete
                   │            │
                   │        next round
                   │            │
                   └──────┬─────┘
                          ▼
                deterministic verify
                          │
                          ▼
                     GROK WRITER
                          │
                          ▼
                 streamed final answer
```

---

# 4. Latency classes

Do not run every question through the same workflow.

Use four classes.

## `FAST`

Examples:

```text
Rewrite this paragraph.
What does this legal term mean?
Summarize these supplied facts.
Who represents defendant X? (if one search is enough)
When is the next hearing in docket X?
```

Execution:

```text
Nemotron → Grok or one direct tool → Grok
```

Research rounds:

```text
0–1
```

---

## `STANDARD`

Examples:

```text
What is the current status of MDL X?
Find the latest rulings on issue Y.
What changed after the latest CMO?
```

Execution:

```text
Nemotron
→ 1 Grok planning turn if needed
→ 2–4 parallel tools
→ 1 Grok synthesis turn
```

Research rounds:

```text
1–3
```

---

## `DEEP`

Examples:

```text
Compare conflicting authorities.
Create a regulatory chronology.
Analyze whether a causation theory changed over time.
Assess several defendants across related litigation.
```

Execution:

```text
Nemotron
→ Grok high-effort planner
→ parallel specialist calls
→ gap analysis
→ additional targeted round(s)
→ verification
→ Grok high-effort writer
```

Research rounds:

```text
2–6
```

---

## `ARTIFACT`

Examples:

```text
Create a research memo.
Create a Word report.
Create an Excel damages analysis.
Create a litigation chronology PDF.
```

Execution:

```text
DEEP or STANDARD evidence pipeline
→ Grok writer creates structured document model
→ deterministic file renderer
→ optional Code Interpreter for calculations/visuals
```

---

# 5. Suggested application folder structure

TypeScript-oriented example:

```text
backend/
├── src/
│   ├── app.ts
│   ├── config/
│   │   ├── env.ts
│   │   ├── models.ts
│   │   ├── latency.ts
│   │   └── source-policy.ts
│   │
│   ├── models/
│   │   ├── nemotron.client.ts
│   │   ├── grok.client.ts
│   │   └── model-router.ts
│   │
│   ├── orchestration/
│   │   ├── router.ts
│   │   ├── orchestrator.ts
│   │   ├── research-loop.ts
│   │   ├── dispatcher.ts
│   │   ├── parallel-executor.ts
│   │   ├── evidence-merger.ts
│   │   ├── completeness.ts
│   │   └── state-compactor.ts
│   │
│   ├── agents/
│   │   ├── legal-research.agent.ts
│   │   ├── court-research.agent.ts
│   │   ├── regulatory-research.agent.ts
│   │   ├── citation-verifier.agent.ts
│   │   ├── browser.agent.ts
│   │   └── writer.agent.ts
│   │
│   ├── tools/
│   │   ├── registry.ts
│   │   ├── contracts.ts
│   │   ├── gateway.client.ts
│   │   ├── web-search.tool.ts
│   │   ├── fetch.tool.ts
│   │   ├── courtlistener.tool.ts
│   │   ├── docketbird.tool.ts
│   │   ├── govinfo.tool.ts
│   │   ├── regulations.tool.ts
│   │   ├── openfda.tool.ts
│   │   ├── clinicaltrials.tool.ts
│   │   ├── sec.tool.ts
│   │   ├── code-interpreter.tool.ts
│   │   ├── browser.tool.ts
│   │   └── document-factory.tool.ts
│   │
│   ├── evidence/
│   │   ├── evidence.types.ts
│   │   ├── authority-ranker.ts
│   │   ├── source-deduper.ts
│   │   ├── citation-normalizer.ts
│   │   └── proposition-verifier.ts
│   │
│   ├── streaming/
│   │   ├── stream.ts
│   │   ├── events.ts
│   │   └── progress-summarizer.ts
│   │
│   ├── ui-contracts/
│   │   ├── assistant-response.ts
│   │   └── choice-panel.ts
│   │
│   ├── cache/
│   │   ├── cache.ts
│   │   ├── redis.ts
│   │   └── source-cache.ts
│   │
│   ├── prompts/
│   │   ├── router.system.md
│   │   ├── orchestrator.system.md
│   │   ├── researcher.system.md
│   │   ├── verifier.system.md
│   │   └── writer.system.md
│   │
│   └── evals/
│       ├── routing.eval.ts
│       ├── tool-choice.eval.ts
│       ├── completeness.eval.ts
│       ├── latency.eval.ts
│       ├── citation.eval.ts
│       └── prose.eval.ts
│
└── tests/
```

Do not allow `router.ts` or `writer.agent.ts` to become giant multi-purpose files.

---

# 6. Core state objects

## 6.1 RequestContext

```ts
export interface RequestContext {
  requestId: string;
  conversationId: string;
  userMessage: string;
  currentDateIso: string;
  userMode?: "auto" | "fast" | "deep";
  conversationSummary?: string;
  recentMessages: ChatMessage[];
  attachments?: AttachmentRef[];
  userSelection?: ChoiceSelection;
}
```

---

## 6.2 RoutePlan

This is the **only** output expected from Nemotron.

```ts
export interface RoutePlan {
  intent:
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

  complexity: "fast" | "standard" | "deep";

  freshness:
    | "not_required"
    | "recent_preferred"
    | "current_required";

  needsTools: boolean;
  needsGrokPlanner: boolean;

  grokReasoning: "low" | "medium" | "high" | "xhigh";

  toolFamilies: ToolFamily[];

  canParallelize: boolean;

  maxResearchRounds: number;

  needsChoicePanel: boolean;
  choicePanel?: ChoicePanel;

  answerStyle:
    | "concise"
    | "normal"
    | "legal_memo"
    | "research_report"
    | "document";

  rationaleCode: string;
}
```

`rationaleCode` should be a short machine-readable label such as:

```text
CURRENT_DOCKET_LOOKUP
AMBIGUOUS_CASE_FAMILY
MULTISOURCE_LEGAL_RESEARCH
NO_EXTERNAL_DATA_NEEDED
```

Do not request a prose rationale.

---

# 7. Nemotron router system prompt

Use a stable prompt and cache it where possible.

```text
You are the low-latency routing controller for a production legal AI system.

Your job is NOT to answer the user.
Your job is NOT to write legal analysis.
Your job is NOT to call tools.

Your only job is to produce the smallest valid RoutePlan that sends the request
through the fastest workflow that is still accurate.

PRIORITIES, IN ORDER:
1. Correctness of route.
2. Current information when the request depends on current facts.
3. Minimum total latency.
4. Minimum unnecessary tool usage.
5. Minimum unnecessary model escalation.

ROUTING RULES:

- Do not use research tools when the user supplied everything needed.
- If a fact may have changed recently, set freshness=current_required.
- Known docket/case status questions should prefer court/docket tools, not generic web search.
- Statutes, regulations, federal publications, agency actions and court materials should prefer primary sources.
- Use generic web search only when structured primary sources are insufficient or discovery is needed.
- Browser automation is a fallback, not a default.
- Code Interpreter is used for computation, extraction, transformation or data analysis, not ordinary prose.
- File creation requires the artifact path but does not automatically require deep research.
- Use Grok planning only when legal judgment, multi-source decomposition, conflicting evidence, multi-step tool dependencies, or completeness judgment is needed.
- If independent sources can be searched simultaneously, set canParallelize=true.
- Do not ask the user a question merely because ambiguity exists. Ask only if different interpretations would materially change the answer or action.
- If ambiguity can be resolved cheaply with parallel research, research it instead.
- Use a choice panel instead of free-text clarification when there are 2–5 clear options.
- Never exceed the configured research-round ceiling.
- Never produce end-user prose.

COMPLEXITY:

FAST:
No research or one obvious tool family; no difficult legal judgment.

STANDARD:
Current factual research or a small number of sources; normal legal synthesis.

DEEP:
Conflicting authorities, cross-jurisdiction analysis, chronology, major litigation
research, regulatory synthesis, scientific/legal integration, or difficult completeness judgment.

GROK REASONING:

low:
Routine writing, straightforward synthesis, obvious tool calling.

medium:
Normal multi-source legal research.

high:
Conflicting evidence, difficult legal synthesis, high-stakes completeness.

xhigh:
Only explicit deep-research workloads where additional latency is acceptable.

Return ONLY RoutePlan.
```

---

# 8. Grok research orchestrator system prompt

```text
You are the research orchestrator for a high-accuracy, latency-sensitive legal AI system.

You receive:
- the user's request;
- conversation context;
- a RoutePlan;
- the available tool catalog;
- prior research rounds, if any;
- an evidence ledger.

Your job is to decide the MINIMUM set of next actions needed to answer accurately.

CORE PRINCIPLES:

1. PRIMARY AUTHORITY FIRST
Prefer official court records, court opinions, statutes, regulations, agency records,
official government repositories, and first-party source documents.

2. RECENCY
When the user asks for status, latest developments, current counsel, scheduled events,
recent orders, deadlines, or other changeable facts, treat recency as mandatory.
Never rely on model memory for a current fact.

3. PARALLELISM
Identify independent research branches and return them in the same ToolCallBatch.
Do not serialize independent calls.

4. DEPENDENCIES
Do not call a downstream tool until required identifiers are known.
Example: first identify the docket, then request docket-specific filings.

5. COMPLETENESS
Before stopping, map evidence back to every material element of the user's request.
A response with several strong sources is still incomplete if an element is unanswered.

6. NEGATIVE CLAIMS
Do not conclude that something does not exist merely because one search did not find it.
Use an appropriately scoped search and say when the record is incomplete.

7. CONFLICTS
When sources conflict:
- surface the conflict;
- rank sources by authority and date;
- retrieve the underlying primary source where possible;
- do not silently choose a weaker source.

8. TOOL DISCIPLINE
Do not search merely because a search tool exists.
Do not repeat materially identical searches.
Do not use Browser if an API, MCP, Web Search, or direct fetch can resolve the task.

9. LATENCY
Prefer one well-designed parallel batch to several sequential calls.
Use narrow queries.
Fetch only the source documents needed for proposition-level support.

10. STOPPING
Stop when:
- all material requested elements have evidence;
- important current facts are verified;
- contradictory evidence is resolved or clearly characterized;
- the writer can produce the answer without guessing.

If not complete, return another targeted ToolCallBatch.
Never create open-ended autonomous loops.

OUTPUT:
Return one structured OrchestratorDecision:
- tool_batch
- complete
- request_user_choice
- escalate_reasoning
- handoff_to_writer
```

---

# 9. Orchestrator decision contract

```ts
export interface OrchestratorDecision {
  status:
    | "tool_batch"
    | "complete"
    | "request_user_choice"
    | "handoff_to_writer";

  calls?: ToolCallSpec[];

  parallelGroups?: string[][];

  missingElements?: string[];

  nextReasoningEffort?: "low" | "medium" | "high" | "xhigh";

  choicePanel?: ChoicePanel;

  writerInstructions?: string[];
}
```

Example:

```json
{
  "status": "tool_batch",
  "calls": [
    {
      "id": "court_search",
      "tool": "courtlistener.search",
      "args": {
        "query": "\"social media\" adolescent addiction",
        "type": "r"
      }
    },
    {
      "id": "recent_web",
      "tool": "web.search",
      "args": {
        "query": "social media adolescent addiction MDL latest order",
        "maxResults": 8,
        "freshness": "current"
      }
    }
  ],
  "parallelGroups": [
    ["court_search", "recent_web"]
  ],
  "missingElements": [
    "latest federal docket activity"
  ],
  "nextReasoningEffort": "medium"
}
```

---

# 10. Grok writer system prompt

Use Grok as a **separate writer role** even if it is the same underlying model.

```text
You are the final legal synthesis and writing model for a professional law-firm AI system.

You receive:
- the user's request;
- relevant conversation context;
- a verified EvidenceBundle;
- research limitations;
- formatting/style instructions.

Your job is to answer the user directly.

WRITING REQUIREMENTS:

- Write clean, natural, professional prose.
- Prefer coherent paragraphs over excessive bullets.
- Sound like an excellent legal researcher or senior associate, not a generic AI report generator.
- Be concise when the question is simple.
- Expand only where complexity requires it.
- Do not repeat the user's question.
- Do not begin with generic throat-clearing.
- Avoid inflated language, filler and unnecessary headings.
- Separate established facts from allegations, argument, inference or unresolved issues.
- Preserve meaningful uncertainty.
- Never manufacture a citation, quotation, docket number, date or procedural event.
- Every current/changeable factual claim must be grounded in current evidence.
- When authorities conflict, explain the conflict rather than flattening it.
- Prefer primary authority over commentary.
- When the available record is incomplete, say exactly what remains unverified.
- Use dates precisely.
- Distinguish the date a source was published from the date the underlying event occurred.

LEGAL SYNTHESIS:

- Connect sources to propositions, not merely source-list.
- Identify what actually matters procedurally or strategically.
- Preserve jurisdiction and procedural posture.
- Do not overstate holdings.
- Distinguish dicta, allegations, party positions, expert opinions and court findings.
- Do not convert association into causation.
- Do not turn absence of evidence into evidence of absence.

STYLE:

Default:
clear, restrained, readable, intelligent, human.

For a normal chat answer:
lead with the answer and explain only what is needed.

For a memorandum:
use professional headings and a strong synthesis-first structure.

For a research report:
use an executive synthesis, organized analysis, tables only when they improve comprehension,
and a source section if requested.

Do not mention internal agent names unless the UI explicitly requests process metadata.
```

---

# 11. Evidence contract

Every research tool should normalize results into one common object before the writer sees them.

```ts
export interface EvidenceItem {
  id: string;

  sourceType:
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

  provider: string;

  authorityLevel: 1 | 2 | 3 | 4 | 5;

  title: string;
  url: string;

  publishedAt?: string;
  eventDate?: string;
  retrievedAt: string;

  court?: string;
  docketNumber?: string;
  caseName?: string;

  excerpt?: string;
  textRef?: string;

  hash?: string;

  supports: string[];
  contradicts: string[];

  primarySource: boolean;
  currentVerified: boolean;

  confidence: number;
}
```

---

# 12. Authority ranking

Encode this in software.

```text
LEVEL 1
Official court filing
Official opinion
Statute
Regulation
Official agency action/document
Official government source

LEVEL 2
Trusted structured repository of primary material
CourtListener / RECAP
GovInfo
ClinicalTrials.gov
SEC structured API

LEVEL 3
High-quality first-party or professional reporting
Issuer/company filing
Major wire / legal journalism

LEVEL 4
Law firm alert
Academic or professional commentary
Treatise-like secondary analysis

LEVEL 5
General web source
Unverified aggregation
Forum / social source
```

Rules:

```text
Level 1 contradiction > Level 4 statement.
Newer source does not automatically beat controlling authority.
Primary source date and event date are separate fields.
Secondary sources are discovery aids, not substitutes for primary authority.
```

---

# 13. External tool registry — recommended canonical names

These are the names **your application should expose to models**, regardless of provider naming.

Keep names short and semantic.

```text
web.search
web.fetch

courtlistener.search
courtlistener.get_docket
courtlistener.get_docket_entries
courtlistener.get_opinion
courtlistener.get_document
courtlistener.verify_citation

docketbird.search_cases
docketbird.get_case
docketbird.get_docket
docketbird.search_filings
docketbird.search_filing_text
docketbird.get_document

govinfo.search
govinfo.describe

regulations.search_documents
regulations.get_document
regulations.search_dockets
regulations.get_docket
regulations.search_comments

fda.search_labels
fda.search_adverse_events
fda.search_enforcement
fda.search_drugs_at_fda

clinicaltrials.search
clinicaltrials.get_study
clinicaltrials.get_version

sec.get_submissions
sec.get_company_facts
sec.fetch_filing

compute.execute
compute.read_file
compute.write_file

browser.open_task

document.create_docx
document.create_pdf
document.create_xlsx
document.create_pptx
```

Do not expose dozens of tiny variants unless they materially improve routing accuracy.

---

# 14. AgentCore Web Search

## Provider

Amazon Bedrock AgentCore Web Search Tool.

## Region

Current documentation:

```text
us-east-1
```

Keep AgentCore Gateway and the main orchestration service in `us-east-1` unless there is a compelling reason not to.

## Gateway target

```text
connectorId: "web-search"
```

Pin connector version:

```text
1.2.0+
```

to obtain request-level domain and publication-date filtering.

## Discovered AWS tool name

```text
WebSearch
```

## Gateway endpoint pattern

```text
https://{GatewayEndpoint}/mcp
```

Call method:

```text
tools/call
```

## Input

```json
{
  "query": "string, maximum 200 characters",
  "maxResults": 10,
  "filters": {
    "domainFilter": {
      "include": ["uscourts.gov", "justice.gov"],
      "exclude": []
    },
    "publishedDateFilter": {
      "from": "2026-08-01T00:00:00Z",
      "to": "2026-09-09T23:59:59Z"
    }
  }
}
```

Current documented `maxResults` range:

```text
1–25
```

## Model-facing wrapper description

```text
Search the current public web using Amazon AgentCore Web Search.
Use for recent/current facts, source discovery and public information not better served by
a dedicated legal or government API. Supports domain and publication-date filtering.
Prefer primary-source domains for legal questions. Do not use when an exact known source
can be fetched directly.
```

## Latency policy

Use:

```text
maxResults = 5–8
```

for normal interactive research.

Use:

```text
maxResults = 10–15
```

for deeper research.

Do not request 25 results by default.

---

# 15. Tool discovery through AgentCore Gateway

When the tool catalog becomes large, enable AgentCore Gateway semantic tool search at Gateway creation.

AWS built-in semantic tool:

```text
x_amz_bedrock_agentcore_search
```

Purpose:

```text
Find the most relevant tools in a large AgentCore Gateway using a natural-language query.
```

MCP 2026-07-28 call pattern:

```http
POST /mcp
MCP-Protocol-Version: 2026-07-28
Mcp-Method: tools/call
Mcp-Name: x_amz_bedrock_agentcore_search
```

Conceptual payload:

```json
{
  "jsonrpc": "2.0",
  "id": "tool-discovery-1",
  "method": "tools/call",
  "params": {
    "name": "x_amz_bedrock_agentcore_search",
    "arguments": {
      "query": "find the latest federal docket filings"
    }
  }
}
```

### Rule

Do not invoke semantic tool discovery on every request if the Nemotron router already maps a common intent to a small known tool family.

Use it when:

```text
tool catalog is large
or
router confidence is low
or
new MCP targets were added dynamically
```

---

# 16. CourtListener

## Preferred integration

For the latency-sensitive hot path, create a small CourtListener adapter with only the endpoints you need.

Official hosted MCP also exists:

```text
https://mcp.courtlistener.com/
```

CourtListener currently supports case law, PACER/RECAP data, dockets, judges, citation network, semantic/keyword search, oral arguments, alerts and citation verification.

## REST base

```text
https://www.courtlistener.com/api/rest/v4
```

Authentication:

```text
Authorization: Token {COURTLISTENER_TOKEN}
```

## Core endpoint map

### Search

```http
GET https://www.courtlistener.com/api/rest/v4/search/
```

Useful result types currently documented include:

```text
o  = opinions
r  = federal cases with matching PACER documents nested
rd = federal filing documents
d  = federal dockets
p  = judges
oa = oral arguments
```

App tool:

```text
courtlistener.search
```

Description:

```text
Search CourtListener for opinions, federal dockets, PACER/RECAP filings, judges or oral
arguments. Prefer for U.S. case law and federal docket research. Use narrow result types
and date/court filters whenever possible.
```

---

### Dockets

```http
GET /api/rest/v4/dockets/{id}/
```

App tool:

```text
courtlistener.get_docket
```

---

### Docket entries

```http
GET /api/rest/v4/docket-entries/?docket={docket_id}
```

App tool:

```text
courtlistener.get_docket_entries
```

---

### Opinions

```http
GET /api/rest/v4/opinions/{opinion_id}/
```

Prefer `html_with_citations` for opinion text where applicable.

App tool:

```text
courtlistener.get_opinion
```

---

### RECAP documents

```http
GET /api/rest/v4/recap-documents/{id}/
```

App tool:

```text
courtlistener.get_document
```

Latency optimization:

Do not request full `plain_text` unless necessary.

---

### Fast RECAP document lookup

```http
GET /api/rest/v4/recap-query/
```

Use when PACER document IDs are known.

---

### PACER fetch fallback

```http
POST /api/rest/v4/recap-fetch/
```

Use only when a required PACER item is not already available through normal retrieval.

---

## CourtListener citation verification

Expose a narrow app-level tool:

```text
courtlistener.verify_citation
```

Input:

```json
{
  "citations": [
    "410 U.S. 113"
  ]
}
```

Output should normalize:

```json
{
  "exists": true,
  "canonicalCitation": "...",
  "caseName": "...",
  "court": "...",
  "date": "...",
  "sourceUrl": "...",
  "verificationStatus": "verified"
}
```

Then separately perform **proposition verification** against opinion text.

Citation existence != proposition support.

---

# 17. DocketBird

DocketBird officially offers a REST API and webhook capability. API keys are obtained from:

```text
https://www.docketbird.com/api
```

DocketBird documentation currently points users to a SwaggerHub definition.

A current public DocketBird MCP implementation uses:

```text
https://api.docketbird.com
```

as the REST base and exposes the endpoint patterns below.

**Production caution:** before hard-coding the DocketBird path/response schema, obtain the current Swagger definition through the DocketBird account/API documentation. The public help-center Swagger deep link was not reliably retrievable during this verification, so the endpoint map below should be schema-checked against your account.

## Recommended app tools

### Search cases

App tool:

```text
docketbird.search_cases
```

Provider pattern used by current public integration:

```http
GET /cases/search
```

Use for:

```text
case discovery
recent cases
finding a provider case ID
```

---

### Get case metadata

```text
docketbird.get_case
```

Provider pattern:

```http
GET /cases/{case_id}
```

---

### Get docket / documents

```text
docketbird.get_docket
```

Provider pattern:

```http
GET /documents?case_id={case_id}
```

Important performance note from the current public MCP wrapper:

```text
The upstream /documents endpoint may return the entire docket rather than true upstream
pagination. Very large dockets can therefore be slow.
```

Do not make this the first call for huge matters if a narrower endpoint can answer the question.

---

### Full-text filing search

```text
docketbird.search_filing_text
```

Provider pattern:

```http
GET /documents/search
```

Use for:

```text
full-text search inside filing bodies
cross-case research
topic/citation search
recent filings
```

This is different from searching docket-entry titles.

---

### Docket-entry title filtering

Do this locally after a docket pull only when the docket is reasonably sized:

```text
docketbird.search_filings
```

For huge dockets, prefer provider-side full-text or other narrowing first.

---

### Document retrieval

```text
docketbird.get_document
```

Return:

```text
document metadata
safe download URL or bytes reference
filing date
case ID
hash
```

Do not send large base64 blobs through the LLM context.

Store/download to S3 and pass an object reference.

---

## DocketBird webhook

Use DocketBird's webhook for **real-time filing ingestion** later.

Preferred pattern:

```text
DocketBird
   ↓ webhook
API Gateway / Lambda URL
   ↓
EventBridge or SQS
   ↓
ingestion worker
   ↓
S3 + metadata index
```

This prevents query-time agents from rechecking already-known firm dockets.

---

# 18. GovInfo MCP

Official GPO MCP endpoint:

```text
https://api.govinfo.gov/mcp
```

Header:

```text
x-api-key: {GOVINFO_API_KEY}
```

Current official MCP tools:

```text
searchGovInfo
describePackageOrGranule
```

Map these to app names:

```text
govinfo.search
govinfo.describe
```

## `govinfo.search`

Description:

```text
Search official GovInfo content and metadata. Prefer for official federal publications,
including statutes, legislative materials, Federal Register content and other documents
hosted by GPO.
```

## `govinfo.describe`

Description:

```text
Retrieve metadata and rendition links for a known GovInfo package or granule, including
available HTML/PDF/XML/ZIP renditions and official metadata.
```

GovInfo is a primary/official government source. Rank appropriately.

---

# 19. Regulations.gov

Base:

```text
https://api.regulations.gov/v4
```

Authentication:

```text
api_key={REGULATIONS_GOV_API_KEY}
```

## Search documents

```http
GET /documents
```

App tool:

```text
regulations.search_documents
```

Example:

```text
https://api.regulations.gov/v4/documents?filter[searchTerm]=water&api_key=...
```

---

## Get document

```http
GET /documents/{documentId}
```

App tool:

```text
regulations.get_document
```

Use `include` where required for attachments.

---

## Dockets

```http
GET /dockets
GET /dockets/{docketId}
```

App tools:

```text
regulations.search_dockets
regulations.get_docket
```

---

## Comments

```http
GET /comments
GET /comments/{commentId}
```

App tool:

```text
regulations.search_comments
```

Do not expose comment-posting capability to the general legal research agent.

---

# 20. FDA / openFDA

Base:

```text
https://api.fda.gov
```

Current documentation recommends an API key for regular use.

## Drug labeling

```http
GET /drug/label.json
```

App tool:

```text
fda.search_labels
```

---

## Drug adverse events

```http
GET /drug/event.json
```

App tool:

```text
fda.search_adverse_events
```

---

## Drug enforcement / recalls

```http
GET /drug/enforcement.json
```

App tool:

```text
fda.search_enforcement
```

---

## Drugs@FDA

```http
GET /drug/drugsfda.json
```

App tool:

```text
fda.search_drugs_at_fda
```

## Legal accuracy rule

openFDA is useful structured data, but do not treat it as the only source for a historical labeling proposition.

If the user asks:

```text
What exactly did the FDA-approved label say on a particular historical date?
```

the research agent should locate/retrieve the actual source document or authoritative historical record in addition to openFDA metadata.

---

# 21. ClinicalTrials.gov

Base:

```text
https://clinicaltrials.gov/api/v2
```

## Search

```http
GET /studies
```

App tool:

```text
clinicaltrials.search
```

---

## Get study

```http
GET /studies/{nctId}
```

App tool:

```text
clinicaltrials.get_study
```

---

## Data version / freshness

```http
GET /version
```

App tool:

```text
clinicaltrials.get_version
```

ClinicalTrials.gov says its dataset is generally refreshed Monday through Friday and recommends checking `dataTimestamp` in `/api/v2/version` for current refresh status.

When freshness matters, record that timestamp in the EvidenceBundle.

---

# 22. SEC EDGAR

## Company submissions

```text
https://data.sec.gov/submissions/CIK##########.json
```

App tool:

```text
sec.get_submissions
```

---

## Company facts

Pattern:

```text
https://data.sec.gov/api/xbrl/companyfacts/CIK##########.json
```

App tool:

```text
sec.get_company_facts
```

---

## Filing documents

Use EDGAR archive URLs after identifying accession and filing path.

App tool:

```text
sec.fetch_filing
```

SEC states submissions/XBRL JSON structures are updated throughout the day as filings are disseminated.

Always use an appropriate identifying User-Agent and comply with SEC access policy.

---

# 23. Direct HTTP fetch tool

Build this as a very fast deterministic service.

App tool:

```text
web.fetch
```

Description:

```text
Retrieve the actual content at a known public HTTP/HTTPS URL. Use after search discovery
when full source text is needed. Prefer over Browser for static HTML, PDFs, JSON and text.
```

## Input

```ts
interface FetchInput {
  url: string;
  mode?: "auto" | "text" | "html" | "json" | "pdf";
  maxBytes?: number;
  timeoutMs?: number;
}
```

## Output

```ts
interface FetchResult {
  finalUrl: string;
  contentType: string;
  status: number;
  title?: string;
  publishedAt?: string;
  retrievedAt: string;
  text?: string;
  s3Ref?: string;
  sha256: string;
}
```

## Required protections

```text
HTTPS preferred
SSRF protection
DNS/IP validation
redirect re-validation
block metadata endpoints
content-type validation
byte-size cap
connect timeout
overall timeout
gzip/brotli support
connection pooling
URL normalization
cache by normalized URL + ETag/Last-Modified where possible
```

## Caching

Cache fetched court opinions, agency PDFs and stable primary sources.

Avoid downloading the same 10 MB PDF five times because five sub-agents found the same URL.

---

# 24. AgentCore Code Interpreter

Use built-in AgentCore Code Interpreter.

Default system identifier in AWS examples:

```text
aws.codeinterpreter.v1
```

Data-plane base:

```text
https://bedrock-agentcore.{Region}.amazonaws.com
```

Start session:

```http
PUT /code-interpreters/{codeInterpreterIdentifier}/sessions/start
```

Invoke tool:

```http
POST /code-interpreters/{codeInterpreterIdentifier}/tools/invoke
```

Session header:

```text
x-amzn-code-interpreter-session-id
```

Current valid built-in invocation names include:

```text
executeCode
executeCommand
readFiles
listFiles
removeFiles
writeFiles
startCommandExecution
getTask
stopTask
```

## App abstraction

Expose only:

```text
compute.execute
compute.read_file
compute.write_file
```

to the model initially.

Do not expose shell/process controls unless needed.

## Use Code Interpreter for

```text
calculations
date math
damages
statistics
tabular transformation
large-result normalization
deduplication
citation lists
timeline sorting
CSV/XLSX processing
graph calculations
chart data
```

Do not use it for:

```text
ordinary summarization
ordinary legal writing
basic JSON reshaping that application code can do faster
```

---

# 25. AgentCore Browser

Browser is a **fallback specialist**, not a default research tool.

Use for:

```text
JS-only court portals
interactive search pages with no API
authenticated workflows
forms
dynamic downloads
web apps where normal fetch fails
```

Do not use for:

```text
ordinary web research
a known static PDF
CourtListener data
GovInfo data
Regulations.gov data
ClinicalTrials.gov data
SEC structured data
```

## App tool

```text
browser.open_task
```

Description:

```text
Use an isolated AgentCore browser session for a website that requires interactive
navigation, JavaScript execution, authentication, forms or dynamic downloads.
Do not call if search/fetch/API access is sufficient.
```

Execute browser automation deterministically with Playwright where possible.

The model should provide a task objective; application code controls the browser session and limits.

---

# 26. File creation / Document Factory

Do not make Code Interpreter your only file-generation pathway.

Create a deterministic document service.

App tools:

```text
document.create_docx
document.create_pdf
document.create_xlsx
document.create_pptx
```

Input should be a structured document AST, not a giant blob of Python.

Example:

```ts
interface DocumentRequest {
  format: "docx" | "pdf" | "xlsx" | "pptx";
  filename: string;
  template?: string;
  title?: string;
  sections: DocumentSection[];
  tables?: TableSpec[];
  charts?: ChartSpec[];
  footnotes?: FootnoteSpec[];
  sources?: SourceSpec[];
}
```

Flow:

```text
Grok
  ↓
structured DocumentRequest
  ↓
validator
  ↓
renderer
  ↓
visual/render QA
  ↓
S3/output reference
```

Use Code Interpreter only when the artifact requires novel computation or custom visuals.

---

# 27. Sub-agent design

Do not create a swarm unless the task requires one.

Recommended logical agents:

## 27.1 Router Agent

Model:

```text
Nemotron 3 Super
```

Tools:

```text
NONE
```

Output:

```text
RoutePlan
```

---

## 27.2 Legal Research Orchestrator

Model:

```text
Grok 4.6
```

Tools:

```text
tool discovery
all approved external research tool families
```

Output:

```text
OrchestratorDecision
```

---

## 27.3 Court Research Specialist

Model:

```text
Grok 4.6 low/medium
```

Tools:

```text
CourtListener
DocketBird
GovInfo if court publication relevant
web.fetch
Web Search fallback
```

Use only when the question is docket/case-law heavy.

---

## 27.4 Regulatory Research Specialist

Model:

```text
Grok 4.6 low/medium
```

Tools:

```text
GovInfo
Regulations.gov
FDA/openFDA
ClinicalTrials.gov
SEC
Web Search
web.fetch
```

---

## 27.5 Citation / Proposition Verifier

Prefer deterministic checks first.

Model:

```text
Grok low only when semantic proposition comparison is required
```

Inputs:

```text
claim
citation
source text
```

Output:

```ts
interface ClaimVerification {
  citationExists: boolean;
  propositionSupported: boolean;
  supportStrength: "direct" | "partial" | "weak" | "contradicted";
  sourceSpan?: string;
  notes?: string;
}
```

---

## 27.6 Browser Specialist

Model:

```text
Grok low
```

Only instantiated when Browser is actually required.

---

## 27.7 Writer

Model:

```text
Grok 4.6
```

No open research loop.

It receives verified evidence and writes.

It may request one targeted research repair if a critical evidence gap prevents an accurate answer.

---

# 28. Multi-round research loop

```ts
async function researchLoop(
  ctx: RequestContext,
  route: RoutePlan
): Promise<EvidenceBundle> {

  const state = createResearchState(ctx, route);

  for (let round = 1; round <= route.maxResearchRounds; round++) {

    emitProgress({
      type: "analysis_status",
      label: round === 1
        ? "Planning research"
        : "Checking remaining evidence gaps"
    });

    const decision = await grokOrchestrator.decide(state);

    if (decision.status === "request_user_choice") {
      throw new ChoiceRequired(decision.choicePanel);
    }

    if (decision.status === "complete" ||
        decision.status === "handoff_to_writer") {
      break;
    }

    const results = await parallelExecutor.run(decision);

    state.add(results);
    state.dedupe();
    state.rankSources();
    state.updateCoverage();

    if (state.isComplete()) break;

    state.compactIfNeeded();
  }

  return verifyEvidence(state);
}
```

## Hard rule

A model never self-authorizes unlimited new rounds.

---

# 29. Parallel tool execution

Model output:

```json
{
  "calls": [
    {"id": "a", "tool": "courtlistener.search", "args": {}},
    {"id": "b", "tool": "docketbird.search_cases", "args": {}},
    {"id": "c", "tool": "web.search", "args": {}}
  ],
  "parallelGroups": [["a", "b", "c"]]
}
```

Runtime:

```ts
const results = await Promise.allSettled(
  group.map(call => executeTool(call))
);
```

## Runtime controls

```text
maximum concurrent external calls per request: start at 4–6
maximum browser sessions per request: 1
maximum duplicate-source fetches: 0
per-tool timeout: tool-specific
global research deadline: mode-specific
cancel irrelevant in-flight work when sufficient evidence is reached
```

Do not allow the LLM to create 30 simultaneous calls.

---

# 30. Query racing

For important current status questions, race complementary providers.

Example:

```text
"latest federal docket activity"
        │
        ├── CourtListener
        └── DocketBird
```

First useful response may populate the UI/evidence.

Second response verifies/completes the record.

For a regulatory query:

```text
official agency API
        +
AgentCore Web Search restricted to official domain
```

Run simultaneously when the cost is justified.

---

# 31. Latency budget strategy

These are **engineering targets**, not AWS latency guarantees.

Instrument before enforcing.

## Router

Target:

```text
very small prompt
small structured response
no tools
no prose
```

Measure:

```text
router TTFT
router completion latency
router input/output tokens
```

---

## Simple current lookup

Desired request shape:

```text
Nemotron
→ 1–2 concurrent API calls
→ Grok low
```

Avoid extra planning model turn when routing is obvious.

---

## Deep request

Immediate UI feedback should begin before research completes.

Target flow:

```text
0 ms      request accepted
<~250 ms  first local progress event
router
tool batch begins
first evidence arrives
writer streaming begins once critical evidence is sufficient
```

Do not delay the first visible UI event until a model emits text.

---

# 32. Streaming protocol

Use SSE or WebSocket.

Recommended event types:

```ts
type AgentStreamEvent =
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
```

Example client timeline:

```text
● Searching court records
  Found 24 docket entries

● Checking the latest order
  Retrieved Aug. 28 case-management order

● Verifying current status
  Cross-checked with a second docket source

● Writing
```

This creates a frontier-agent feel without exposing chain-of-thought.

---

# 33. Multiple-choice selection panel

Yes — add this as a native response primitive.

The LLM does not render HTML.

The router/orchestrator emits structured UI.

## Contract

```ts
export interface ChoicePanel {
  id: string;
  title: string;
  description?: string;
  selectionMode: "single" | "multiple";
  options: ChoiceOption[];
  allowOther?: boolean;
}

export interface ChoiceOption {
  id: string;
  label: string;
  description?: string;
  value: string;
  recommended?: boolean;
}
```

Example:

```json
{
  "id": "3m-case-choice",
  "title": "Which 3M litigation?",
  "description": "There are multiple major 3M matters.",
  "selectionMode": "single",
  "options": [
    {
      "id": "afff",
      "label": "AFFF / PFAS",
      "description": "MDL 2873",
      "value": "afff"
    },
    {
      "id": "earplugs",
      "label": "Combat Arms Earplugs",
      "description": "Separate MDL / settlement program",
      "value": "earplugs"
    },
    {
      "id": "both",
      "label": "Both",
      "value": "both",
      "recommended": true
    }
  ],
  "allowOther": true
}
```

## When to use a panel

Use only when:

```text
2–5 clear alternatives exist
AND
the distinction materially changes the answer/workflow
AND
the system cannot infer the intended option with sufficient confidence
```

Examples:

```text
Which litigation?
Which jurisdiction?
Quick answer vs deep research?
Which artifact format?
Which date period?
Which defendant/matter?
```

Do not interrupt users with choice panels for trivial preferences.

---

# 34. Choice panel execution

On selection, client sends:

```json
{
  "type": "choice_selection",
  "panelId": "3m-case-choice",
  "selected": ["afff"]
}
```

Persist it as a normal conversation event.

Then resume the same request state.

Do not restart the entire research process if already-completed work remains useful.

---

# 35. Conversation context

Do not send the entire chat indefinitely.

Maintain:

```text
recent verbatim turns
+
durable conversation summary
+
active task state
+
verified entities/identifiers
+
current evidence ledger
```

Example:

```ts
interface ConversationMemory {
  rollingSummary: string;
  activeMatter?: {
    caseName?: string;
    docketNumber?: string;
    court?: string;
    providerIds?: Record<string, string>;
  };
  confirmedUserChoices: Record<string, string>;
  recentMessages: ChatMessage[];
}
```

For internal legal data later, add authorization-scoped matter context separately.

---

# 36. Grok multi-turn reasoning continuity

If using a Grok Responses API path that returns:

```text
reasoning.encrypted_content
```

you may store the opaque value server-side and include it in subsequent model turns where supported.

Use case:

```text
research planner round 1
→ encrypted reasoning state
→ tools execute
→ planner round 2 receives tool results + opaque state
```

Benefits:

```text
preserves model continuity
reduces need to restate internal reasoning
keeps raw reasoning hidden
```

Do not log or expose decrypted/raw reasoning.

Always retain a separate explicit application-level ResearchState so system correctness does not depend on model-private state.

---

# 37. Research state compaction

After each round, compact tool outputs.

Bad:

```text
feed 120 KB raw HTML back to model
```

Good:

```text
EvidenceItem metadata
+ relevant spans
+ source URL
+ source hash
+ unresolved propositions
```

Keep original raw source outside model context.

State compactor should never discard:

```text
case identifiers
court
dates
citation
source URL
key quoted/supporting span
contradiction status
unresolved question
```

---

# 38. Prompt caching

Grok 4.6 currently supports prompt caching.

Design a stable prefix:

```text
system prompt
tool-use rules
source hierarchy
output contracts
```

Keep request-specific data after the stable prefix.

Do not rebuild enormous tool schemas on every round if Gateway semantic discovery can narrow the tool set.

---

# 39. Tool descriptions matter

A tool description should tell the model:

```text
what the tool does
when to use it
when NOT to use it
important latency/coverage limitations
whether it searches metadata or full text
whether the data is primary or secondary
```

Bad:

```text
Search documents.
```

Good:

```text
Full-text search inside federal/state court filing bodies in DocketBird. Use when the
user needs filings containing a phrase, citation, company, product or legal issue.
This searches filing text, not merely docket-entry titles. Prefer a case/court/date
filter when known because broad cross-corpus searches can be slower.
```

---

# 40. Tool timeout policy

Suggested starting values:

```text
AgentCore Web Search:       4–6 s
CourtListener search:       4–6 s
CourtListener direct get:   3–5 s
GovInfo:                    4–6 s
Regulations.gov:            4–6 s
openFDA:                    4–6 s
ClinicalTrials.gov:         4–6 s
SEC:                        4–6 s
web.fetch:                  6–10 s
DocketBird:                 endpoint-specific; broad searches may need longer
Browser:                    20–40 s
Code Interpreter:           task-specific
```

These are application starting points, not provider guarantees.

Use circuit breakers.

A failed secondary provider should not automatically fail the entire answer if sufficient primary evidence exists elsewhere.

---

# 41. Retry policy

Do not retry every error blindly.

```text
429         → Retry-After / exponential backoff
5xx         → 1 bounded retry for fast APIs
timeout     → 1 retry if idempotent and budget remains
401/403     → no retry; auth/config issue
404         → no retry unless alternate identifier exists
invalid     → repair request once, then fail gracefully
```

For DocketBird broad full-text calls, consider a narrower court/case split rather than simply repeating a large timed-out query.

---

# 42. Duplicate-call prevention

Before executing a tool call:

```ts
fingerprint = sha256(
  toolName +
  canonicalJson(args)
)
```

If identical fingerprint already completed during this request:

```text
reuse result
```

If identical fingerprint already in-flight:

```text
await same promise
```

This eliminates common agentic waste.

---

# 43. Evidence coverage matrix

For deep research, create a task-level coverage matrix.

Example:

```ts
interface ResearchRequirement {
  id: string;
  description: string;
  required: boolean;
  evidenceIds: string[];
  status: "missing" | "partial" | "verified" | "conflicted";
}
```

A regulatory chronology might produce:

```text
FDA labeling                       verified
international regulatory action   verified
epidemiology                       partial
manufacturer action                verified
litigation events                  verified
unresolved science                 verified
```

Grok should only continue researching the `partial`/`missing` cells.

This sharply reduces repeated web searching.

---

# 44. Completeness gate

Before writer handoff:

```ts
function readyForWriter(state: ResearchState): boolean {
  return (
    state.requiredRequirements.every(
      x => x.status === "verified" || x.status === "conflicted"
    ) &&
    state.currentFactsAreFresh &&
    state.noCriticalUnknownIdentifiers &&
    state.citationIntegrityPassed
  );
}
```

For normal chat, use lighter thresholds.

For formal legal reports, use stricter thresholds.

---

# 45. Writer evidence access

Do not let the writer receive unrestricted tools by default.

Prefer:

```text
Writer gets verified EvidenceBundle
```

If it notices a critical gap:

```text
Writer → ResearchRepairRequest
```

The orchestrator performs one targeted repair.

This prevents the writer from entering an uncontrolled search loop.

---

# 46. Fast direct-write path

Many messages do not require research.

Example:

```text
"Make this paragraph shorter and more professional."
```

Do:

```text
Nemotron route
→ Grok low
→ stream
```

No tools. No planner. No verifier.

---

# 47. Fast current-status path

Example:

```text
"What is the latest status of MDL 3047?"
```

Suggested:

```text
Nemotron
→ parallel:
    CourtListener docket search
    DocketBird case/docket lookup
→ Grok low/medium
→ stream answer
```

Skip a separate Grok planning turn unless identifier resolution fails or sources conflict.

---

# 48. Deep legal research path

Example:

```text
"Assess whether defendants' causation theory materially changed after the latest Rule 702 ruling and subsequent bellwether discovery."
```

Suggested:

```text
Nemotron deep route
→ Grok high planner
→ CourtListener + DocketBird + Web Search parallel
→ fetch primary rulings
→ evidence merge
→ Grok high gap analysis
→ targeted second round
→ proposition/citation verification
→ Grok high writer
```

---

# 49. Browser escalation policy

Only the orchestrator may request Browser.

Router sets:

```text
toolFamilies includes browser
```

but runtime still checks:

```ts
if (apiAvailable || fetchAvailable) {
  rejectBrowserCall("Use structured/fetch path first");
}
```

This protects latency.

---

# 50. Source-date normalization

Every tool wrapper should extract both:

```text
publication/filing date
event/effective date
```

Examples:

```text
News published Sept. 9 about order entered Sept. 8
FDA page updated Sept. 9 describing labeling change effective Aug. 30
Court filing uploaded Sept. 7 but order signed Sept. 6
```

Writer receives both.

---

# 51. User-facing citations

UI citation object:

```ts
interface UiCitation {
  id: string;
  label: string;
  title: string;
  url: string;
  sourceType: string;
  publishedAt?: string;
  eventDate?: string;
  excerpt?: string;
}
```

Render citations at claim level where possible.

Do not dump an undifferentiated list of 30 sources at the bottom if 6 actually support the answer.

---

# 52. Recommended external-tool use by legal task

| Task | First tool | Parallel verifier | Fallback |
|---|---|---|---|
| Federal case status | CourtListener/DocketBird | Other docket provider | Web Search |
| Federal filing text | DocketBird/CourtListener RECAP | Web Search | Browser |
| Case law | CourtListener | GovInfo when applicable | Web Search |
| Citation validation | CourtListener | opinion fetch | Web Search |
| Federal publication | GovInfo | Web Search official domains | Fetch |
| Regulations | Regulations.gov | GovInfo/Federal Register discovery | Web Search |
| FDA label/data | FDA/openFDA | Web Search `fda.gov` | Fetch |
| Clinical trial | ClinicalTrials.gov | publication search | Web Search |
| Public company filing | SEC | Web Search `sec.gov` | Fetch |
| General current legal news | AgentCore Web Search | primary court/agency source | Fetch |
| JS-only site | API/fetch first | — | AgentCore Browser |
| Calculations/data | Code Interpreter | deterministic validation | — |
| DOCX/PDF/XLSX/PPTX | Document Factory | render QA | Code Interpreter |

---

# 53. Do not create unnecessary sub-agents

A specialist sub-agent is justified when:

```text
it has a distinct tool subset
or
it can run independently in parallel
or
it needs a materially different prompt
or
its result is reusable/testable
```

Do not create:

```text
"thinking agent"
"analysis agent"
"reasoning agent"
"summary agent"
```

just to make the architecture look agentic.

Each extra model hop costs latency.

---

# 54. Example router outcomes

## Simple writing

User:

```text
Rewrite this client update.
```

Route:

```json
{
  "intent": "rewrite",
  "complexity": "fast",
  "freshness": "not_required",
  "needsTools": false,
  "needsGrokPlanner": false,
  "grokReasoning": "low",
  "toolFamilies": [],
  "canParallelize": false,
  "maxResearchRounds": 0,
  "needsChoicePanel": false,
  "answerStyle": "normal",
  "rationaleCode": "NO_EXTERNAL_DATA_NEEDED"
}
```

---

## Current case status

User:

```text
What is the status of MDL 3047?
```

Route:

```json
{
  "intent": "docket_status",
  "complexity": "standard",
  "freshness": "current_required",
  "needsTools": true,
  "needsGrokPlanner": false,
  "grokReasoning": "low",
  "toolFamilies": ["courtlistener", "docketbird"],
  "canParallelize": true,
  "maxResearchRounds": 2,
  "needsChoicePanel": false,
  "answerStyle": "normal",
  "rationaleCode": "CURRENT_DOCKET_LOOKUP"
}
```

---

## Complex regulatory analysis

User:

```text
Create a comprehensive chronology of regulatory actions and scientific evidence for a drug risk.
```

Route:

```json
{
  "intent": "regulatory",
  "complexity": "deep",
  "freshness": "current_required",
  "needsTools": true,
  "needsGrokPlanner": true,
  "grokReasoning": "high",
  "toolFamilies": [
    "fda",
    "regulations",
    "govinfo",
    "clinicaltrials",
    "web"
  ],
  "canParallelize": true,
  "maxResearchRounds": 6,
  "needsChoicePanel": false,
  "answerStyle": "research_report",
  "rationaleCode": "MULTISOURCE_REGULATORY_SYNTHESIS"
}
```

---

# 55. Metrics to instrument from day one

Per request:

```text
router latency
router input tokens
router output tokens
route selected
Grok reasoning effort
number of Grok rounds
time to first progress event
time to first tool start
time to first evidence
time to first answer token
total latency
tool count
parallel batch count
duplicate calls prevented
cache hits/misses
browser used?
code interpreter used?
citation pass rate
primary-source percentage
research requirements satisfied
user retry / regeneration rate
```

Per tool:

```text
p50
p95
p99
timeout rate
5xx rate
429 rate
result usefulness
result selected by writer?
```

---

# 56. Evaluation suite

Build a fixed legal routing benchmark.

Examples:

```text
1. Current MDL status → should use docket tools.
2. Historical Supreme Court holding → CourtListener; web not required.
3. Current FDA label → FDA + current source verification.
4. "Rewrite this memo" → no tools.
5. Docket filing mentions phrase → full-text docket search, not generic web.
6. Interactive JS state portal → Browser only after direct paths fail.
7. Calculate damages table → Code Interpreter.
8. Create Word memo → Document Factory.
9. Ambiguous "3M case" → choice panel if context cannot resolve it.
10. Complex regulatory chronology → Grok planner + parallel specialists.
```

Score:

```text
correct route
unnecessary tool calls
source authority
freshness
completeness
citation correctness
time to first token
total latency
final prose quality
```

---

# 57. Failure behavior

The system should degrade gracefully.

Example:

```text
CourtListener times out
DocketBird succeeds
```

Do not automatically perform five more searches.

Writer can say:

```text
The current docket status is supported by DocketBird; CourtListener was unavailable during this request.
```

if the missing cross-check matters.

If a primary source cannot be retrieved:

```text
explicitly identify the limitation
do not present secondary reporting as equivalent primary authority
```

---

# 58. Suggested environment variables

```text
AWS_REGION=us-east-1

NEMOTRON_MODEL_ID=nvidia.nemotron-super-3-120b

GROK_MODEL_ID=xai.grok-4.6
GROK_US_RUNTIME_MODEL_ID=us.xai.grok-4.6
GROK_GLOBAL_RUNTIME_MODEL_ID=global.xai.grok-4.6
GROK_MANTLE_BASE_URL=https://bedrock-mantle.us-west-2.api.aws/openai/v1

AGENTCORE_GATEWAY_URL=
AGENTCORE_GATEWAY_TOKEN_OR_AUTH_CONFIG=

COURTLISTENER_TOKEN=
DOCKETBIRD_API_KEY=
GOVINFO_API_KEY=
REGULATIONS_GOV_API_KEY=
OPENFDA_API_KEY=

REDIS_URL=
ARTIFACT_BUCKET=
SOURCE_CACHE_BUCKET=
```

Prefer AWS IAM / Secrets Manager / Identity flows over plaintext long-lived secrets in production.

---

# 59. Suggested request API

```http
POST /api/chat
```

Request:

```json
{
  "conversationId": "conv_123",
  "message": "What is the latest status of MDL 3047?",
  "mode": "auto"
}
```

Response:

```text
SSE stream
```

Events:

```text
request_started
route_selected
analysis_status
tool_started
tool_result
verification_status
writer_started
text_delta
citation
completed
```

---

# 60. Suggested choice API

```http
POST /api/chat/{requestId}/choice
```

Payload:

```json
{
  "panelId": "matter-selection",
  "selected": ["afff"]
}
```

Resume existing orchestration state.

---

# 61. High-level model adapter

```ts
interface ModelAdapter {
  generate<T>(request: ModelRequest<T>): Promise<ModelResponse<T>>;
  stream(request: ModelRequest): AsyncIterable<ModelStreamEvent>;
}
```

Implement:

```text
NemotronBedrockAdapter
GrokBedrockMantleAdapter
```

This prevents provider-specific payloads from leaking throughout orchestration code.

---

# 62. Pseudocode — request controller

```ts
async function handleChat(ctx: RequestContext) {
  emit({ type: "request_started", requestId: ctx.requestId });

  const route = await router.route(ctx);

  emit({
    type: "route_selected",
    mode: route.complexity,
    label: routeLabel(route)
  });

  if (route.needsChoicePanel && route.choicePanel) {
    emit({
      type: "choice_panel",
      panel: route.choicePanel
    });
    return;
  }

  if (!route.needsTools) {
    return writer.stream(ctx, emptyEvidence(), route);
  }

  const evidence =
    route.needsGrokPlanner
      ? await researchLoop(ctx, route)
      : await executeFastResearch(ctx, route);

  const verified = await verifier.verify(evidence, route);

  return writer.stream(ctx, verified, route);
}
```

---

# 63. Pseudocode — fast research

```ts
async function executeFastResearch(
  ctx: RequestContext,
  route: RoutePlan
) {
  const calls = deterministicFastPathTools(ctx, route);

  emit({
    type: "analysis_status",
    label: "Checking current sources"
  });

  const results = await Promise.allSettled(
    calls.map(executeTool)
  );

  return normalizeEvidence(results);
}
```

This is why obvious current-status questions should not always pay for an extra Grok planning round.

---

# 64. Pseudocode — Grok writer stream

```ts
async function* writeAnswer(
  ctx: RequestContext,
  evidence: EvidenceBundle,
  route: RoutePlan
) {
  yield {
    type: "writer_started",
    label: "Writing"
  };

  const request = buildWriterRequest({
    ctx,
    evidence,
    style: route.answerStyle,
    reasoning: route.grokReasoning
  });

  for await (const event of grok.stream(request)) {
    if (event.type === "output_text_delta") {
      yield {
        type: "text_delta",
        delta: event.delta
      };
    }
  }
}
```

---

# 65. Security / law-firm controls to preserve now

Even though internal matter tools are deferred, build the interfaces correctly now.

Every tool call should carry:

```text
requestId
conversationId
user/workload identity
tool name
tool version
timestamp
source URL
result hash
latency
authorization outcome
```

Do not put provider API keys into model context.

Do not let the browser access unrestricted internal networks.

Do not allow generic fetch to hit:

```text
169.254.169.254
localhost
private RFC1918 ranges
link-local
internal metadata endpoints
```

unless an explicit future internal connector is designed for that purpose.

---

# 66. What is intentionally deferred

Do not block this build on:

```text
internal matter RAG
firm DMS
permission-aware retrieval
Litify
SharePoint
iManage
internal deposition graph
internal matter graph
internal user files
knowledge-base permissions
```

Create interfaces now:

```text
internal.search
internal.fetch
internal.graph_query
```

but keep them disabled/unregistered until the security and permission model is ready.

---

# 67. Phase order

## Phase 1 — Core speed path

Build:

```text
Nemotron router
Grok writer
SSE stream
choice panel
RoutePlan schema
metrics
```

Acceptance:

```text
non-research writing works
simple questions route correctly
first progress event is immediate
```

---

## Phase 2 — Current public research

Add:

```text
AgentCore Gateway
AgentCore Web Search
web.fetch
CourtListener
DocketBird
```

Acceptance:

```text
current docket-status questions use direct legal tools
parallel calls work
sources are deduplicated
writer gets normalized evidence
```

---

## Phase 3 — Government/regulatory

Add:

```text
GovInfo
Regulations.gov
FDA/openFDA
ClinicalTrials.gov
SEC
```

Acceptance:

```text
regulatory chronology evaluation
source hierarchy evaluation
freshness evaluation
```

---

## Phase 4 — Frontier multi-round research

Add:

```text
Grok planner
coverage matrix
gap analysis
bounded research loop
citation/proposition verifier
state compaction
```

---

## Phase 5 — Compute / browser / artifacts

Add:

```text
AgentCore Code Interpreter
AgentCore Browser
Document Factory
render QA
```

---

## Phase 6 — Internal tools later

Add only after permission/security architecture is ready.

---

# 68. Acceptance tests for "frontier-like"

The system is not done because tools technically work.

It should satisfy:

```text
[ ] Fast rewriting never invokes research.
[ ] Current legal facts never rely only on model memory.
[ ] Docket questions prefer docket APIs.
[ ] Independent tools execute concurrently.
[ ] Browser is rarely used in ordinary research.
[ ] Duplicate searches are prevented.
[ ] Deep research has a hard loop limit.
[ ] Grok detects unresolved evidence gaps.
[ ] User sees useful progress immediately.
[ ] Raw chain-of-thought is never rendered.
[ ] Choice panels appear only when materially useful.
[ ] Final prose is clean and non-robotic.
[ ] Primary sources are preferred.
[ ] Citation existence and proposition support are separate checks.
[ ] Source publication date and event date are distinguished.
[ ] Tool failures do not unnecessarily destroy the whole response.
[ ] Every request has latency telemetry.
```

---

# 69. Current official references

## AWS Bedrock — Nemotron 3 Super

https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-nvidia-nemotron-super-3-120b.html

## AWS Bedrock — Grok 4.6

https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-xai-grok-4-6.html

## AWS Bedrock pricing

https://aws.amazon.com/bedrock/pricing/

## AgentCore Gateway

https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/gateway.html

## AgentCore Gateway semantic tool search

https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/gateway-using-mcp-semantic-search.html

## AgentCore Web Search

https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/gateway-target-connector-web-search-tool.html

## AgentCore Code Interpreter

https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/code-interpreter-tool.html

## AgentCore Code Interpreter API

https://docs.aws.amazon.com/bedrock-agentcore/latest/APIReference/API_InvokeCodeInterpreter.html

## AgentCore Browser

https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/browser-tool.html

## CourtListener REST v4 Search

https://www.courtlistener.com/api/rest/v4/search/

## CourtListener hosted MCP

https://mcp.courtlistener.com/

## CourtListener API documentation

https://wiki.free.law/c/courtlistener/help/api/rest/v4/search

## DocketBird API help

https://support.docketbird.com/en/articles/15281460-docketbird-api-and-webhook

## GovInfo MCP

https://api.govinfo.gov/mcp

## GovInfo MCP documentation

https://github.com/usgpo/api/blob/main/docs/mcp.md

## Regulations.gov API

https://open.gsa.gov/api/regulationsgov/

## openFDA

https://open.fda.gov/apis/

## ClinicalTrials.gov API

https://clinicaltrials.gov/data-about-studies/learn-about-api

## SEC EDGAR APIs

https://www.sec.gov/search-filings/edgar-application-programming-interfaces

---

# 70. Final recommended production behavior

The system should behave as follows:

```text
USER
  ↓
NEMOTRON 3 SUPER
  ↓
"Can answer directly?"
      ├── yes → GROK WRITER → stream
      │
      └── no
           ↓
"Obvious fast tools?"
      ├── yes → execute in parallel → verify → GROK WRITER
      │
      └── no
           ↓
GROK ORCHESTRATOR
  ↓
small parallel research batch
  ↓
evidence coverage
  ↓
complete?
  ├── yes → verify → GROK WRITER
  └── no  → targeted next batch (bounded)
```

And the user should experience:

```text
fast first visible feedback
current primary-source research
minimal waiting
intelligent tool selection
clean streaming UI
only useful clarifying choices
strong legal prose
source-grounded answers
```

That is the target architecture.