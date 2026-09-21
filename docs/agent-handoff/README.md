# Research, Discovery and Workflows: external engineering handoff

Prepared September 21, 2026. Research/Discovery audited source: `f06e148fdda93553718621ab3634ce53548d7bfe`; Workflows: `0afb944b739406e1e3327e589431ac16f4ad4eb1`. These documents describe findings and work to implement; they are not completed feature claims or live AWS acceptance. Keep the delivered Office/PDF implementation intact. The default repository branch is `feat/frontier-ux`; Frontier remains a retiring pipeline regardless of that branch name.

## Read in this order

1. [Repository start page](../../EXTERNAL_AGENT_START_HERE.md): branch, delivery state, production boundary.
2. [Implementation and verification runbook](IMPLEMENTATION-RUNBOOK.md): common invariants, ordered work, looping, commands, failure injection, acceptance and handoff.
3. [Research orchestration](research/RESEARCH-ORCHESTRATION-REVIEW.md): active pipeline, tool streaming, routing, temporal accuracy, source versioning, cancellation, parallel workers and context.
4. [Discovery overview](discovery/DISCOVERY-WORKFLOW-REVIEW.md): actual tabs, shared architecture, prioritized findings, performance plan and quality gates.
5. [Ingestion and KB retrieval](discovery/ingest-kb-findings.md), [Depositions](discovery/deposition-findings.md), then [Tabular Review](discovery/review-findings.md): exact code references and reproductions by subsystem.
6. [Browser startup blocker](discovery/ingest-kb-browser-triage.md): why four native Discovery browser tests did not reach their workflow assertions.
7. [Workflows overview and implementation sequence](workflows/WORKFLOWS-ORCHESTRATION-REVIEW.md), then [engine/dataflow](workflows/engine-findings.md), [durable backend](workflows/backend-findings.md) and [tools/evidence/exports](workflows/tools-findings.md). Read [validation evidence](workflows/validation-evidence.json) before interpreting the recorded tests or probes.
8. [Office handoff](../office-external-agent-handoff.md), especially AgentCore migration, and [release runbook](../release/DEV-TO-PROD.md) before touching shared transport or infrastructure.

## Owner decisions that govern this work

- **Frontier Research is legacy and retiring.** Optimize the active `runResearchAgent` pipeline. Do not enable Frontier or make its parity a prerequisite. A useful helper may be reused only after validating it in the active path; historical Frontier findings are not an active work queue.
- Bedrock remains the production reasoning/model transport. Production Jev/TypeSafe access must use authenticated AgentCore Gateway and an adapter that calls TypeSafe. This migration is proposed, not established as deployed. Reuse the existing signed Gateway pattern; do not just substitute a base URL.
- Improve speed with correct routing, compact context, bounded parallelism, deterministic tools, reuse and durable recovery. Preserve thoroughness, real source coverage and user edits. Jev confidence is not factual proof.
- Do not add new external research providers during this pass. Work with existing tools and report unavailable capabilities explicitly.
- No live AWS, production models, real firm data or deployed configuration was validated by these audits. Source parameters are configuration intent. Credentials are obtained through the operator's environment, never from this repository or copied conversation history.

## Evidence status

Research's recorded baseline is **249 tests passed**. Discovery's recorded baseline is **317 tests passed**, with **7 browser tests passed and 4 blocked by local native startup**. These are historical, differently scoped runs, not a combined fresh acceptance total. Read each report's limits and rerun relevant checks on the new implementation.

Workflows recorded **71 focused tests passed**, its scoped TypeScript check passed, and the initial browser suite had **4 passes and 1 failure**. A targeted rerun reached the library and failed a stale catalog expectation; the initial startup timeout was not independently explained. These are not live-service checks. An abandoned backend probe failed to intercept SDK dependencies: four failed test paths attempted DynamoDB reads/queries and stopped at TLS verification, with no successful operation observed and exact wire retry count unknown. The replacement probe blocked network access. This exception is preserved in the evidence; the original invalid harness is not included.

Included synthetic JSON records document counterexamples. A passing counterexample assertion means a defect was reproduced, not fixed. Original local scripts/raw logs/browser traces are not part of this handoff; turn the described fixtures into portable repository regressions before implementing their fixes. Pinned GitHub source links identify the audited version; line numbers can move in later code.

Start with integrity and cancellation defects, then durable coverage/recovery, then throughput and AgentCore-mediated Jev. See the runbook for the precise dependency order and the work that can proceed independently.
