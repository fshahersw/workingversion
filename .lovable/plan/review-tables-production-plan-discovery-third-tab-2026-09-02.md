# Review Tables — production plan (Discovery, third tab)

A spreadsheet over a document set: rows = documents, columns = questions you write.
Every cell carries a cited answer, a status, and an audit trail. Built for mass-tort
work: PFS deficiency triage, medical-record chronology fields, deposition exhibit
indexes, privilege-log drafting, production QC.

## What the research says we must get right

From the competitive read (Relativity aiR for Review, Everlaw Review Assistant,
Legora Tabular Review, Harvey Vault review tables, Hebbia Matrix, Kira):

1. Pinpoint cites per cell — click a cell, land on the page that produced it. Not a
   document-level "source".
2. An explicit **Not found** state, distinct from an error and from a low-confidence
   answer. A blank cell is unusable in litigation.
3. **Sample before you run.** Run a column on 10 documents, read the answers, fix the
   prompt, then run the population. This is the single feature that separates
   defensible from toy (Relativity's Prompt Criteria Validation, backed by the IADC
   defensibility white paper).
4. **Human override that survives re-runs.** Edit a cell, mark it verified, and it is
   locked; re-running the column never overwrites it silently.
5. **Column drift control.** The same prompt across 5,000 rows must mean the same
   thing on row 4,900 as on row 40 — fixed model, fixed temperature, versioned prompt,
   snapshotted per run.
6. Export that keeps the cite (page + document), not just the answer text.
7. Row grouping — a medical chart plus its billing record is one row, two files.
8. Near-duplicate awareness, so 40 copies of one record don't read as 40 confirmations.

## Capacity

Current Discovery working set is browser-side and ephemeral: `MAX_FILES = 120`,
`MAX_PAGES = 20,000`, 150 MB, sessions expire (`src/lib/pile/limits.ts`,
`src/lib/use-pile.ts`, `src/lib/pile/store.ts`). That is fine for Summarize; it is the
wrong substrate for a review table you come back to next week.

Review Tables therefore run on the **server-side scratch corpus** already in place
(`supabase/corpus/scratch-corpus.sql`: `scratch.sessions/documents/pages/chunks/jobs`,
hybrid BM25 + vector search, worker queue) — promoted from 3-day rolling retention to
durable, owner-scoped storage for table-backed sets.

Targets for v1:
- 2,000 documents per table (soft cap; queue-bounded, not architecture-bounded)
- 12 columns
- ~24,000 cells per table, processed in bounded batches with live progress
- 5–10 columns is the recommended working range

## Column types

Each column has a name, a question/instruction, and an output type:

| Type | Cell value | Notes |
|---|---|---|
| Text | short free text | default |
| Long text | paragraph | summaries, privilege descriptions |
| Yes / No / Unclear | enum | three-state, never two |
| Date | ISO date | normalized, original string kept |
| Number / Currency | numeric + unit | |
| Single select | from a list you define | responsiveness, privilege basis, issue tag |
| Multi select | list | issue tags |
| List | array of strings | providers, medications, exhibit numbers |

Every cell, regardless of type, also carries: `status`
(`answered | not_found | needs_review | error`), `confidence`
(`high | medium | low`), `citations[]` (document, page, quoted span), and
`rationale` (one or two sentences on how the answer was reached).

## Screens

```text
Discovery   [ Summarize ]  [ Depositions ]  [ Review Tables ]

+-- table header ------------------------------------------------+
| Insulin PFS triage   2,140 docs   12 cols   Run  Export  Share |
+-------------+----------+-------------+-------------+-----------+
| Document    | Exposure | Product ID  | Prior suit  | Deficient |
+-------------+----------+-------------+-------------+-----------+
| PFS_0041.pdf| 2016-03  | Lantus      | No          | * flag    |
| PFS_0042.pdf| -- not   | Humalog     | Unclear     | * flag    |
|             |   found  |             |             |           |
+-------------+----------+-------------+-------------+-----------+
                                     v click a cell
+-- cell drawer -------------------------------------------------+
| Exposure window - PFS_0042.pdf            Not found            |
| Rationale: no exposure dates in sections 4-6.                  |
| Searched: p.3, p.7, p.11                                       |
| [ Open reader ]  [ Enter value ]  [ Mark verified ]            |
+----------------------------------------------------------------+
```

- **Grid** — virtualized, sticky first column, zebra rows. Cell chips: value plus a
  small cite count; amber left-edge for `needs_review`, muted italic for `not_found`.
- **Column editor** — name, type, question, optional select options, and a
  *Test on 10 documents* button that returns sample answers side by side before you
  commit the column to the full set. Prompt edits bump the column version.
- **Cell drawer** — value, rationale, citation list, pages searched, override field,
  verify/lock toggle, change history.
- **Reader** — reuses the Discovery reader; opens to the cited page with the quoted
  span highlighted.
- **Run bar** — cells queued / running / done / failed, with cancel and
  *re-run failed only*.
- **Filters** — by column value, status, confidence, verified/unverified. Saved views.

## Execution

Per cell: retrieve within that one document (hybrid BM25 + vector over
`scratch.chunks`, page-span aware, the same machinery as `pile-index.ts` /
`scratch_hybrid_search`), pack the top spans, and ask the model for a strict JSON
object matching the column's output type. Cells are independent — no cross-document
lumping — which is exactly the fan-out pattern already used in
`src/lib/pile/ask.server.ts`.

- Model: configured Bedrock Claude Sonnet, temperature 0, small max-tokens per cell.
- Concurrency: bounded worker pool over `scratch.jobs`; per-table queue so one big
  table can't starve another.
- Caching: cell result keyed by `(document, column version, model, prompt hash)`.
  Re-running a column only recomputes cells whose key changed, and never touches
  verified cells.
- Run snapshot: model id, prompt text, retrieval settings and timestamp stored per run
  so any exported table can be explained later.
- Failures: retried twice, then `error` with the message on the cell.

## Data model (app-managed DB, owner-scoped RLS)

- `review_tables` — id, owner, name, matter_id/label, scratch session, timestamps
- `review_columns` — table, name, type, question, options, version, position
- `review_rows` — table, scratch document id(s) (array, for grouped rows), label, position
- `review_cells` — row, column, value_json, status, confidence, citations jsonb,
  rationale, verified_by/at, overridden, cache_key, run_id
- `review_runs` — table, columns run, model/prompt snapshot, counts, started/finished
- `review_cell_history` — cell, previous value, actor, timestamp

All tables get GRANTs plus `auth.uid() = owner` policies.

## Export

- XLSX — one sheet of values, a second sheet of cites (row, column, document, page,
  quote), a third with the run snapshot.
- CSV — values only, with a cite column.
- Both mark unverified and `not_found` cells explicitly.

## Build order

1. Schema + persistence, and promote a scratch session to a durable table set.
2. Grid shell with columns, rows, and the column editor including *Test on 10*.
3. Cell execution worker, run bar, caching, retries.
4. Cell drawer, cites, reader jump, override + verify + history.
5. Filters, saved views, export.
6. Near-duplicate grouping and row grouping for multi-file rows.

Stages 1–4 are the usable product; 5–6 are the polish that makes it a daily tool.

## Rollback safety

Built so the whole feature can be switched off or removed without touching
anything that exists today.

- **Additive only.** New route file, new components under
  `src/components/docs/review/`, new server modules under `src/lib/review/`,
  new `review_*` tables. No existing Summarize / Depositions / scratch code path
  is modified except one line in `DocsWorkspace.tsx` to register the third tab.
- **Feature flag.** A single `REVIEW_TABLES_ENABLED` switch hides the tab and
  short-circuits the API routes. Flip it off and the app is exactly as it is now.
- **Schema is isolated.** Every new table is prefixed `review_` and references
  nothing existing except `auth.users` for ownership. Removing the feature means
  dropping that prefix group; no existing table is altered, and no column is
  added to an existing table.
- **Scratch stays as it is.** Durable table sets get a new `retained` flag on the
  session rather than a change to the current sweep behavior, so existing
  Summarize sessions keep expiring on the same 3-day clock.
- **Staged commits.** Each of the six build steps lands as its own commit so any
  single stage can be reverted independently.

## Out of scope for v1

Cross-table analytics, privilege-log-specific formatting, sharing beyond the owner,
and statistical validation metrics (precision/recall against a coded sample) — the
*Test on 10* sampling loop covers the practical need first.

