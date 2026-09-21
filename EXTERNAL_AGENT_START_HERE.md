# External coding agent: start here

The completed Office/PDF implementation and the Research/Discovery engineering guides are on **`codex/office-pdf-quality`** in this repository. Clone this branch explicitly; a default-branch clone may omit this delivery.

```sh
git clone --branch codex/office-pdf-quality --single-branch https://github.com/fshahersw/workingversion.git
cd workingversion
git status --short
git log -5 --oneline
```

Read **[the Research and Discovery handoff index](docs/agent-handoff/README.md)** and **[the implementation and verification runbook](docs/agent-handoff/IMPLEMENTATION-RUNBOOK.md)** before changing those workflows. They link the active Research audit, all Discovery tabs, ingestion/retrieval, concrete counterexamples, ordered work packets, long-run recovery, and release criteria.

For Office/PDF work, read **[the existing step-by-step Office handoff](docs/office-external-agent-handoff.md)**. It contains the code map, local setup, validation commands, remaining parity gaps and AWS release checks. Preserve the delivered Office changes while modifying shared model and routing infrastructure.

**Scope correction from the owner:** Frontier Research is legacy and will be retired. Do not optimize or enable it as the replacement pipeline. Work on the active Research agent and active Discovery surfaces. Any references to Frontier in historical audit evidence are context, not implementation tasks.

**Latest architecture requirement:** production JEV/TypeSafe calls must go through an authenticated AWS AgentCore Gateway tool backed by an adapter that calls TypeSafe. Bedrock remains the production reasoning model transport. The current implementation still calls TypeSafe directly; migration is a prerequisite to expanding production JEV use, not a completed/deployed feature. Research/Discovery integrity fixes can proceed first or independently, following the runbook. Do not simply change the TypeSafe base URL to a Gateway URL: they use different protocols and authentication.

Office implementation checkpoint: `b3fd979a4ca06ced9169c4444f66363b6a886675`. Research and Discovery audits examined `f06e148fdda93553718621ab3634ce53548d7bfe`. Original public baseline: `e595931af932953a0f3ef70e9cfb80a837c001bc`. This documentation delivery publishes recommendations and recorded audit evidence; it does not implement those recommendations. Reconcile findings against your checked-out code before editing.

- [Delivered changes and verification](docs/office-native-parity-delivery.md)
- [GenOffice parity and explicit remaining gaps](docs/genoffice-tool-parity.md)
- [Synthetic native acceptance files](samples/office-acceptance/README.md)
- [Active Research orchestration audit](docs/agent-handoff/research/RESEARCH-ORCHESTRATION-REVIEW.md)
- [Discovery architecture and improvement plan](docs/agent-handoff/discovery/DISCOVERY-WORKFLOW-REVIEW.md)

AWS deployment and actual Microsoft desktop Office acceptance remain outstanding. No test API keys, local database, emulator state, or generated deployment bundles are included. Obtain environment access separately; do not copy credentials from conversation history into source files.
