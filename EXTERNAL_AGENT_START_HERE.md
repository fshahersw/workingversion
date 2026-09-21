# External coding agent: start here

The completed Office/PDF implementation is on **`codex/office-pdf-quality`** in this repository. Clone this branch explicitly; the repository's default branch is currently `feat/frontier-ux`.

```sh
git clone --branch codex/office-pdf-quality --single-branch https://github.com/fshahersw/workingversion.git
cd workingversion
git status --short
git log -5 --oneline
```

Read **[the step-by-step external agent handoff](docs/office-external-agent-handoff.md)** before changing code. It contains the reading order, exact code map, local setup, validation commands, recovery loop, remaining parity gaps, AWS release checks, and the next implementation task.

**Latest architecture requirement:** production JEV/TypeSafe calls must go through an authenticated AWS AgentCore Gateway tool backed by an adapter that calls TypeSafe. Bedrock remains the production reasoning model transport. The current implementation still calls TypeSafe directly; the AgentCore migration is the first follow-up task, not a completed/deployed feature. Do not simply change the TypeSafe base URL to a Gateway URL: they use different protocols and authentication.

Implementation checkpoint: `b3fd979a4ca06ced9169c4444f66363b6a886675`. Original public baseline: `e595931af932953a0f3ef70e9cfb80a837c001bc`. The newer handoff commit adds instructions and synthetic acceptance files without changing runtime behavior.

- [Delivered changes and verification](docs/office-native-parity-delivery.md)
- [GenOffice parity and explicit remaining gaps](docs/genoffice-tool-parity.md)
- [Synthetic native acceptance files](samples/office-acceptance/README.md)

AWS deployment and actual Microsoft desktop Office acceptance remain outstanding. No test API keys, local database, emulator state, or generated deployment bundles are included. Obtain environment access separately; do not copy credentials from conversation history into source files.
