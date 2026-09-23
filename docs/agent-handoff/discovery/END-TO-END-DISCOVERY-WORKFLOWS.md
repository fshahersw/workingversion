# End-to-end discovery workflows: courts, obligations, and a platform design

> Forward-looking design note (September 2026). This is a design and sequencing
> proposal, not a claim of shipped behavior. It complements the read-only
> [Discovery workflow review](DISCOVERY-WORKFLOW-REVIEW.md) (which audits what
> the Working Set / Depositions / Tabular Review surfaces do today) by mapping
> the **legal discovery lifecycle** onto the platform's existing building blocks
> and specifying concrete workflows that could be assembled on the Workflows
> engine. Where it names a module it is grounding the design in real code; where
> it proposes new behavior it says so. Nothing here deploys AWS resources or
> asserts production readiness.

## 1. Why this document

The platform already ingests, indexes, and reviews documents (Working Set),
parses and analyzes testimony (Depositions), and runs column extraction with
citation/verification passes (Tabular Review). It also has a research agent with
authoritative web search, docket tools, and citation verification, plus a
general **Workflows** engine with a rich typed step catalog. What is missing is
an explicit model of the **litigation discovery process** that ties these
surfaces into repeatable, court-aware, end-to-end workflows — the way a
litigation team actually experiences discovery: obligations, deadlines,
requests, responses, productions, privilege, and motion practice.

This note supplies that model and shows how each phase maps to existing code and
to composable workflow definitions.

## 2. Discovery in U.S. courts — the ground truth the product must respect

Civil discovery is governed by the Federal Rules of Civil Procedure (and close
state analogues). The platform's "Discovery" surface should be legible to a
litigator in these terms:

| Phase | Governing rule (federal) | Core artifacts | What a team needs from software |
| --- | --- | --- | --- |
| Scope & proportionality | FRCP 26(b)(1) | Claims/defenses map, proportionality factors | Keep every answer inside the case's defined scope; surface proportionality arguments |
| Preservation / legal hold | Common law + 37(e) | Hold notices, custodian list, ESI sources | Track custodians and sources; evidence that preservation happened |
| Rule 26(f) conference & ESI protocol | FRCP 26(f), 16(b) | Meet-and-confer report, ESI protocol, scheduling order | Draft/track the protocol; extract agreed formats, search terms, clawback terms |
| Initial disclosures | FRCP 26(a)(1) | Disclosure sets | Assemble witnesses, documents, damages, insurance from the matter record |
| Written discovery — requests | FRCP 33 (interrogatories), 34 (RFPs), 36 (RFAs) | Served requests | Parse incoming requests into a tracked, numbered obligation list |
| Written discovery — responses & objections | FRCP 33–36, 34(b)(2) | Responses, objections, responsive-document sets | Draft responses grounded in the document set; carry objections; map each request to evidence |
| Document production | FRCP 34(b)(2)(E) | Bates-stamped productions, load files, privilege log | Track what was produced, in what form, with a defensible privilege log |
| Privilege | FRCP 26(b)(5), FRE 502 | Privilege log, clawback | Identify privileged material, generate a log, support 502(d) clawback |
| Depositions | FRCP 30, 31, 32 | Notices, transcripts, exhibits, designations | Prep outlines from the record; analyze transcripts; designate testimony |
| Experts | FRCP 26(a)(2) | Reports, disclosures | Compare reports; Rule 702 posture (already a research task) |
| Discovery disputes | FRCP 37, 26(c) | Meet-and-confer letters, motions to compel, protective orders, sanctions | Draft letters/motions grounded in the specific deficient responses |
| Deadlines | Scheduling order, local rules | Fact-discovery cutoff, expert deadlines | A single deadline ledger tied to the matter and docket |

Two invariants must hold across every phase, and they line up with the audit's
integrity findings:

1. **Completeness is measured against the served request and the full source
   inventory**, never against whatever happened to parse. A response cannot be
   "complete" if responsive custodians/pages were silently dropped (see the
   review's P1 completeness findings).
2. **Every produced or asserted fact is traceable** to a document, page, and
   (for testimony) an authentic printed line — not an inferred coordinate.

## 3. Building blocks already in the codebase

The design reuses, rather than reinvents, these:

- **Docs / Discovery surface** — `src/components/docs/DocsWorkspace.tsx`,
  `src/lib/use-pile.ts`, `src/lib/use-deposition.ts`,
  `src/lib/review/use-review-table.ts`, `src/lib/kb/workspace.functions.ts`.
  Working sets, deposition analysis, and tabular review already exist.
- **Research agent tools** — `src/lib/agents/research-tools.server.ts` and
  `src/lib/agents/tools.server.ts`: `web_search` (category-scoped, ranked),
  `fetch_page`, `verify_citations` (CourtListener), the `db_*` DocketBird tools
  (find case, docket sheet, search filings, read filing, calendar), and the
  regulatory/PubMed/SEC tools.
- **Workflows engine** — `src/lib/workflows/` with a typed step catalog
  (`catalog.ts`, `plan-schema.ts`, `engine.ts`, `graph.ts`). Directly relevant
  step kinds already defined: `trigger`, `files`, `selection`, `agent`,
  `extract`, `table`, `compare`, `citations`, `review`, `search`, `web`,
  `scrape`, `condition`, `foreach`, `merge`, `document`, `edit`, `response`,
  `notify`. (`python` is intentionally unsupported in plans — see
  `plan-schema.ts` `PLAN_UNSUPPORTED`.)
- **Office / Drafts** — native DOCX/XLSX generation and delivery for producing
  response documents, privilege logs, and letters (`src/lib/office/*`,
  `src/writer/*`).
- **Library** — durable home for working sets, saved outputs, drafts, and
  prompts (`src/routes/_authenticated/library.tsx`).

The key insight: a "discovery workflow" is mostly a **typed graph over these
existing steps**, plus a small amount of new domain state (the request ledger,
the deadline ledger, the privilege log).

## 4. Proposed end-to-end workflows

Each workflow below is expressed as a plan over existing step kinds so it can run
on `engine.ts`. Inputs/outputs are concrete; new domain state is called out.

### 4.1 Incoming written-discovery intake → obligation ledger

**Goal:** turn a served set of RFPs/interrogatories/RFAs (a PDF/DOCX) into a
tracked, numbered obligation list.

Plan: `trigger(files)` → `extract` (split the document into individually
numbered requests with type = RFP/ROG/RFA and any instructions/definitions) →
`table` (one row per request: number, verbatim text, type, due date computed
from service date + rule period, status) → `response` (persist as a new
**Request Ledger** artifact in the Library).

New state: a `RequestLedger` record (matter-scoped) with per-request status
(`unstarted | drafting | objected | responded | supplemented`). Reuses the
review table persistence patterns — and must adopt the audit's compare-and-set
revision guarding so concurrent edits never clobber a newer status.

### 4.2 RFP response drafting (request ↔ evidence mapping)

**Goal:** for each RFP, find responsive documents in the working set and draft a
response + objections.

Plan: `foreach` request in the ledger → `search`/`review` over the matter's
Working Set (reusing tabular review's extract → citation-check → verify passes)
to gather candidate responsive documents → `agent` step drafts a response that
(a) states the objection posture, (b) lists responsive documents by Bates/source
id, and (c) never asserts a document is responsive without a source id →
`document` (assemble the formal response set in Office) → `merge` back into the
ledger with per-request evidence links.

Guardrails (from §2 invariants): completeness is scored against the working
set's **full page inventory**, and every "responsive" claim carries a resolvable
source id. An `agent` step cannot mark a request `responded` without at least
one cited responsive document or an explicit objection.

### 4.3 Privilege review → privilege log

**Goal:** identify likely-privileged documents and generate a defensible log.

Plan: `foreach` document in the responsive set → `agent` privilege classifier
(attorney-client / work product / neither, with the basis and the
author/recipient/date it relied on) → `condition` (privileged?) → `table`
(privilege log rows: Bates range, date, author, recipients, type, basis) →
`document` (export the log as XLSX/DOCX) → `response` (persist).

This is a JEV-appropriate **classification** at the routing layer (privileged
vs. not, confidence), with deterministic code owning the log schema, the
required columns, and the redaction/withhold decision — consistent with the
platform's "Jev routes, deterministic code decides" principle and the
AgentCore-mediated transport requirement in the external-agent handoff. It must
never auto-withhold on model confidence alone; low-confidence rows are queued
for human review.

### 4.4 Deposition preparation pack

**Goal:** from the matter record + transcripts, build a deposition outline.

Plan: `selection` (custodian/witness + topics) → `search` across the Working Set
and prior deposition analyses (`use-deposition.ts`) → `compare` (prior sworn
testimony vs. document record, to surface contradictions) → `agent` (outline:
topics, exhibits by source id, impeachment lines with exact prior-testimony
citations) → `document` (outline DOCX) → `notify`/`response`.

Reuses the existing deposition **exact-quotation** matching and its rejection of
ambiguous matches. Per the audit, impeachment citations must use authentic
printed page/line, never inferred segment coordinates.

### 4.5 Meet-and-confer / motion-to-compel drafting

**Goal:** when responses are deficient, draft the Rule 37 letter/motion grounded
in the specific deficiencies.

Plan: `foreach` request flagged deficient in the ledger → `agent` (articulate
the deficiency: boilerplate objection, non-responsive, withheld without a log
entry) → `citations`/`verify_citations` for any case law cited (CourtListener) →
`document` (letter or motion) → `response`. `web_search` supplies current
authority; the new **fast quick-answer** (`web-quick-answer.server.ts`,
`WEB_QUICK_ANSWER`) gives the fast tier a grounded one-liner (e.g., the standard
for a motion to compel in the forum) before it commits to a full research loop.

### 4.6 Discovery deadline ledger (cross-cutting)

**Goal:** one place that knows every discovery deadline for the matter.

Plan: seed from the scheduling order (`extract` from the order PDF) and from the
docket (`db_docket_sheet`, `db_calendar`), then `table` into a **Deadline
Ledger** with rule-computed dates (service + response period, meet-and-confer
windows, fact/expert cutoffs). `condition` + `notify` drive reminders. This
ledger is the trigger source for the workflows above (e.g., an RFP response
workflow auto-created when a request set is served).

## 5. Data model additions (minimal, matter-scoped)

Three new durable records, all reusing the existing DynamoDB workspace/job
patterns and the audit's integrity requirements (compare-and-set revisions,
owner checks after await, monotonic run generation):

- `RequestLedger` — the served requests and their per-request status/evidence.
- `PrivilegeLog` — withheld/redacted entries with basis and human-review state.
- `DeadlineLedger` — matter deadlines with source (order vs. docket vs. rule).

Each is an audited artifact surfaced in the Library alongside working sets and
saved outputs, so the new Library empty states / actions extend naturally to a
"No requests logged yet — import a served set" onboarding entry.

## 6. UI surface plan

- **Discovery (`/docs`)** gains a fourth tab, **Requests**, showing the
  obligation ledger with status chips and a per-request drawer (verbatim text,
  responsive documents, objection, response draft link).
- **Research** stays the entry point for authority questions; the fast
  quick-answer makes single-lookup discovery-law questions (response periods,
  meet-and-confer requirements, forum standards) resolve in one grounded
  sentence with citations.
- **Library** hosts the ledgers/log as first-class artifacts (the refreshed
  empty states already point users to Discovery to create them).

## 7. Honest status and constraints

- **Exists today:** Working Set ingestion/retrieval, Depositions analysis,
  Tabular Review extraction/verification, the research agent + docket/citation
  tools, the Workflows engine and step catalog, Office document generation.
- **Proposed here (not built):** the RequestLedger/PrivilegeLog/DeadlineLedger
  domain state, the discovery-specific workflow plans, the Requests tab, and the
  onboarding entries.
- **Sequencing:** land the integrity fixes the audit calls out first (immutable
  source inventory, compare-and-set review writes, authentic testimony
  coordinates). Discovery workflows built on unreliable completeness/coordinates
  would inherit those defects at higher volume.
- **Model transport:** classification-style steps (privilege, request typing,
  effort routing) are JEV-appropriate but, per the external-agent handoff, must
  reach the vendor through the AgentCore Gateway in production, not a direct
  call. Reasoning/drafting stays on Bedrock. No workflow here bypasses write-mode
  policy on a model's say-so.
- **Not covered:** actual AWS deployment, court-specific local-rule encodings
  beyond FRCP defaults, and certified privilege determinations. Those require
  jurisdiction data and human sign-off the platform should route to, not
  automate away.
