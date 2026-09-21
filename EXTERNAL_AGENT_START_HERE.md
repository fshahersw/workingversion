# External coding agent: start here

The delivered Office/PDF implementation and the Research, Discovery and Workflows engineering guides are in this repository. Use the default branch, **`feat/frontier-ux`**, after this documentation delivery is merged. That historical branch name does not change the instruction to retire the Frontier pipeline.

```sh
git clone --branch feat/frontier-ux --single-branch https://github.com/fshahersw/workingversion.git
cd workingversion
git status --short
git log -5 --oneline
```

Read **[the engineering handoff index](docs/agent-handoff/README.md)** and **[the implementation and verification runbook](docs/agent-handoff/IMPLEMENTATION-RUNBOOK.md)** before changing these surfaces. They link active Research, Discovery tabs and ingestion/retrieval, the Workflows builder/engine/backend/tools/exports, concrete counterexamples, ordered work packets, long-run recovery and release criteria.

For Office/PDF work, read **[the existing step-by-step Office handoff](docs/office-external-agent-handoff.md)**. It contains the code map, local setup, validation commands, remaining parity gaps and AWS release checks. Preserve the delivered Office changes while modifying shared model and routing infrastructure.

**Scope correction from the owner:** Frontier Research is legacy and will be retired. Do not optimize or enable it as the replacement pipeline. Work on the active Research agent and active Discovery surfaces. Any references to Frontier in historical audit evidence are context, not implementation tasks.

**Latest architecture requirement:** production JEV/TypeSafe calls must go through an authenticated AWS AgentCore Gateway tool backed by an adapter that calls TypeSafe. Bedrock remains the production reasoning model transport. The current implementation still calls TypeSafe directly; migration is a prerequisite to expanding production JEV use, not a completed/deployed feature. Research/Discovery integrity fixes can proceed first or independently, following the runbook. Do not simply change the TypeSafe base URL to a Gateway URL: they use different protocols and authentication.

Office implementation checkpoint: `b3fd979a4ca06ced9169c4444f66363b6a886675`. Research and Discovery audits examined `f06e148fdda93553718621ab3634ce53548d7bfe`; Workflows examined `0afb944b739406e1e3327e589431ac16f4ad4eb1`. Original public baseline: `e595931af932953a0f3ef70e9cfb80a837c001bc`. This documentation delivery publishes recommendations and recorded audit evidence; it does not implement those recommendations. Reconcile findings against your checked-out code before editing.

- [Delivered changes and verification](docs/office-native-parity-delivery.md)
- [GenOffice parity and explicit remaining gaps](docs/genoffice-tool-parity.md)
- [Synthetic native acceptance files](samples/office-acceptance/README.md)
- [Active Research orchestration audit](docs/agent-handoff/research/RESEARCH-ORCHESTRATION-REVIEW.md)
- [Discovery architecture and improvement plan](docs/agent-handoff/discovery/DISCOVERY-WORKFLOW-REVIEW.md)
- [Workflows orchestration, integrity and parallel execution plan](docs/agent-handoff/workflows/WORKFLOWS-ORCHESTRATION-REVIEW.md)

AWS deployment and actual Microsoft desktop Office acceptance remain outstanding. No test API keys, local database, emulator state, or generated deployment bundles are included. Obtain environment access separately; do not copy credentials from conversation history into source files.
