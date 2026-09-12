# Discovery reliability and deposition evidence review

This local change set belongs to `fshahersw/workingversion`, based on
`74f53064ec7e82732f11027d4e01f6ff6b2e1173` (`feat/frontier-ux`). The local branch is
`codex/discovery-reliability-graph`. It changes Discovery and the shared persistence
paths that Discovery uses. It does not integrate the separate MCO application or
change Workflows. No commit, push, deployment, database migration, or production
document write was performed for this work.

## Local development

```powershell
cd C:\Users\firas\Downloads\prodrepo\workingversion-discovery-review
bun install --frozen-lockfile
node node_modules/vite/bin/vite.js dev --host 127.0.0.1 --port 5176 --strictPort
```

Open `http://127.0.0.1:5176/docs?tab=deposition`. Working set uses `tab=search` and
Tabular Review uses `tab=review`. Existing local servers on other ports were left
alone. The app retains its real Cognito sign-in and server authorization checks.
No runtime fixture mode or auth bypass was added.

The repository's default Cognito callback is `http://localhost:8080/auth/callback`.
Port 8080 was already occupied when this checkout was started. To authenticate
locally, use a callback/logout URL allowed by the intended Cognito app client and
matching this dev server; configure `COGNITO_REDIRECT_URI` and
`COGNITO_LOGOUT_URI` with the other environment settings. Do not assume the
machine's default AWS profile is the Seeger Weiss application account. No remote
SSO configuration was changed. Without the correct configuration the local app
renders its sign-in screen, and live storage/Bedrock calls are not validated.

## Saving depositions

The reported incident was “analysis succeeded, then failed saving.” Its exact
historical production cause remains unconfirmed without the failing request and
server logs. The inspected code exposed independently reproducible reliability
problems addressed here:

- Original-file uploads and searchable-text saves now accept up to 200 MiB.
  Background conversion keeps its separate 50 MiB limit. Previously a transcript
  accepted by deposition intake could be rejected by the 50 MiB save validation.
- `prepareOnly` reserves the owned Library workspace before the slow ingest
  call. Analysis writes can start once that reservation exists, independently of
  search indexing. Repeated transport attempts use the reservation identity;
  terminal ingest failures require a new attempt under the existing terminal
  state machine.
- Parsed pages and document identity are checkpointed before embeddings. The
  Library can reopen a deposition with saved analysis and recoverable pages even
  when its search index failed. `ready` is not fabricated for a failed index.
- Read-only status polling never starts another ingest job. Analysis-save retry
  writes the existing result; it does not call the model again. Index and analysis
  errors have separate state so one successful operation cannot erase the other
  operation's warning.
- Missing conversion configuration is reported before submitting background work.
  An original upload failure is distinguished from a successful text save.
- Pending analysis is kept in memory, can be exported, and gets a browser unload
  warning. This is not crash recovery or an offline durable queue. No transcript
  content is cached in localStorage.

Relevant implementation: `src/lib/use-deposition.ts`, `src/lib/kb/workspace.functions.ts`,
`src/lib/kb/workspace.server.ts`, `src/lib/kb/ingest.server.ts`, and
`src/components/summarize/DepositionView.tsx`.

## Evidence and graph semantics

Every extracted graph relationship can carry an exact source filename, quotation,
and page/line citation. Verification searches the complete normalized quotation
within one transcript. Ambiguous filenames or occurrences, wrong source files,
and short/unmatched quotations do not acquire verified citations. Normalized text
indexes are reused per parsed transcript, and matching line spans use binary
search instead of rebuilding and scanning every line for every finding.

**Source matched means quotation provenance, not legal correctness.** A real quote
does not prove the model interpreted a relationship or potential conflict correctly.
The interface makes that distinction explicit. Legacy relationships without quotes
remain inspectable under **Needs review**. Unmatched quotations are excluded from
quoted findings; a potential contradiction is withheld if either side lacks a
matched quote. No fabricated confidence percentages are supplied.

Graph merges remap model-local node IDs before joining edges. Different people
sharing a surname are not merged or treated as the same witness. Transcript
attribution uses direct source evidence, not mere proximity to another node.

The graph provides:

- Compact Graph/List switching, evidence and transcript filters, text search,
  reset controls that remain reachable even with zero matches, and CSV export.
- A relationship evidence panel with both quotations for paired conflicts and
  source-specific page/line navigation. CSV includes both sides of paired evidence.
- Node cards spaced apart, labels describing relationships, fit-to-entities zoom,
  and a responsive evidence panel that opens on selection.
- Existing graph lenses, source-aware questions, clusters, and cross-witness views.

Primary files: `src/components/summarize/KnowledgeGraph.tsx`, `GraphEvidence.tsx`,
`src/lib/pile/deposition-analysis.ts`, `graph-view.ts`, and `dep-intel.ts`.

## Reading and analysis coverage

Deposition reading waits for OCR to settle before analysis and persistence start.
Noisy individual pages are eligible even when other pages are readable. Failed or
budget-excluded OCR pages are reported; coverage is never described as complete
merely because the readable portions finished. Re-run is disabled during OCR.
Duplicate transcript filenames and page/file limits are checked explicitly.
Strict deposition extraction rejects over-limit PDF, DOCX, and TXT instead of
silently discarding their ending; other consumers retain their existing extraction
mode.

Analysis windows preserve complete text rather than taking the first few thousand
characters. Findings reach synthesis in bounded batches; cross-review compares
every finding batch with itself and the other batches, using concurrency two.
This improves coverage but pairwise cross-review can be expensive for very large
sets. The UI exposes progress and cancellation; model quality still requires
evaluation on representative real transcripts. Incomplete/malformed responses are
reported while successful covering windows remain available.

## Tabular Review

- Retain computed cell writes until the server acknowledges them. The retry
  action saves pending answers without paying for another model run.
- Protect manually edited/verified cells with an atomic conditional DynamoDB
  write, including when review occurs while an AI request is still in flight.
- Use a SHA-256 digest of the actual page text and numbering (including OCR
  repairs) for fresh document identity. A filename and page count alone cannot
  authorize reuse of old answers. Existing persisted document IDs remain usable.
- Limit parallel saved-workspace retrieval and show search/status filters over
  the review rows. Null/unanswered cells are handled correctly by the filters.
- Report failed run initialization, failed persistence, and incomplete runs
  separately from successful AI computation.

## Verification and remaining deployment checks

Verified locally on September 12, 2026: **415 unit tests and 8 browser tests pass**.
TypeScript, ESLint on changed source files, the production build, and
`git diff --check` pass. The dev server remains listening on port 5176.

```powershell
npm test
node node_modules/typescript/bin/tsc --noEmit --pretty false
node node_modules/@playwright/test/cli.js test --config playwright.discovery.config.ts
node node_modules/vite/bin/vite.js build
```

The Playwright tests intercept API responses only in the test browser. Synthetic
transcripts live exclusively under `tests/discovery`; they are neither product
routes nor seeded application records. Tests exercise the real Discovery shell,
the graph's source navigation/filter/export controls, strict extraction, and a
completed analysis surviving a storage outage and retry without extra model calls.
A separate browser test reopens stored analysis and checkpointed transcript pages
after search indexing fails, without starting a new analysis.
Browser screenshots/traces are local artifacts under `.discovery.local/`.

The connection graph now includes automatic **Mapped insights** and smooth
selection framing. See [deposition-mapped-insights.md](./deposition-mapped-insights.md)
for the evidence requirements, bounded graph algorithms, responsive camera,
interaction details, and dedicated browser regressions.

Before deployment, use the intended account/environment to validate Cognito,
S3 permissions/CORS, Aurora/embedding access, the async conversion resources, and
a representative transcript's save/reopen/export path. No live model or document
write was used as a substitute for this check. Large pages and analysis records
still travel through existing JSON server-function transports and inherit the
host's request-size/timeout limits; this change does not implement multipart
analysis uploads or a background analysis job service. The existing saved-record
envelope and ownership checks are retained, and no schema migration is required.
