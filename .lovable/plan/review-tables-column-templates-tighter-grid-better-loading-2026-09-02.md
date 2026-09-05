# Review Tables: column templates, tighter grid, better loading

Three additive changes to the Review Tables tab. No backend/schema changes, no change to how cells are answered.

## 1. One-click column templates

A "Templates" button next to "Column" in the grid header opens a picker of curated litigation packs. Picking one appends every column in that pack in one action (existing columns are kept; duplicates by name are skipped), then the user can run the table immediately.

Packs (each column carries a name, answer type, options where relevant, and a grounded question):

- **Contract review** (~22 columns): parties, effective date, term/expiration, renewal, governing law, venue/forum, arbitration, assignment/change of control, indemnity, limitation of liability, cap amount, warranty, confidentiality, term of confidentiality, termination for convenience, notice period, payment terms, fees/pricing, exclusivity, non-compete, insurance, signature block/authority.
- **Privilege & responsiveness pass** (~14): privilege call, privilege basis, attorney names, client names, work-product, responsive to requests, confidentiality designation, PII/PHI present, redactions needed, custodian, document type, date of document, author, recipients.
- **Deposition / transcript intake** (~12): deponent, role, date, admissions, key concessions, exhibits referenced, objections, privilege instructions, expert opinions offered, dates discussed, entities named, follow-up needed.
- **Medical records / injury** (~16): patient, provider, encounter date, diagnosis codes, injury described, causation statements, prior conditions, treatment plan, imaging, medications, work restrictions, disability duration, billed amount, paid amount, referral, discharge date.
- **Corporate / due diligence** (~18): entity name, jurisdiction, formation date, officers, directors, ownership/cap table, subsidiaries, litigation disclosed, liens, licenses/permits, regulatory approvals, related-party transactions, financial statements referenced, revenue figures, debt obligations, insurance policies, IP assets, employee counts.
- **Court filings / docket** (~14): filing type, filing party, court, judge, case number, date filed, relief sought, legal claims, statutes cited, key cases cited, opposing party, deadlines, hearing date, disposition.

Adding a pack raises the column cap: `REVIEW_MAX_COLUMNS` goes from 12 to 40 so 10-30 column packs fit. A soft warning appears above ~20 columns noting cell count and run time (columns x documents).

## 2. Tighter, cleaner grid

- Compact density: header row and cells lose vertical padding, row height fixed to a single consistent line-clamped block, narrower default column width (240px to 200px) and a slightly narrower document column, thinner 1px borders in a single tone.
- Better alignment: numeric/date columns right-aligned, Yes/No rendered as a small status pill, page citations moved to a muted single-line footer clipped with ellipsis instead of wrapping.
- A density toggle (Compact / Comfortable) in the toolbar, persisted per browser.
- Sticky header and sticky document column keep their shadow, but the shadow is applied only when scrolled so the resting state reads flat and clean.
- Toolbar tightened: one row with table name, doc/column counts, run/cancel, export menu, templates, density; overflow items collapse into the existing dropdown at narrow widths.

## 3. Skeleton loading for parallel cell fill

- While a run is active, every cell queued or in flight renders a shimmer skeleton bar (two short bars for long-text columns) instead of the current dash, so the grid visibly fills in parallel rather than looking empty.
- Cells resolve with a brief fade/settle transition; failed cells keep the current error affordance.
- Column and row headers show a thin indeterminate progress underline while any of their cells are in flight.
- The existing progress bar gains a done/total plus "n running" readout and keeps Cancel.
- Skeletons respect reduced-motion (static muted blocks, no shimmer).

## Technical notes

- New file `src/lib/review/templates.ts`: typed pack definitions (`ColumnDraft[]` per pack) — pure data, no imports beyond `types.ts`.
- `src/lib/review/use-review-table.ts`: add `addColumns(drafts)` that creates columns sequentially with correct positions and skips existing names; expose the set of in-flight cell keys from the run loop for skeleton state.
- `src/components/docs/review/ReviewGrid.tsx`: density prop, skeleton cell rendering, alignment by column kind, header progress underline.
- New `src/components/docs/review/TemplatePicker.tsx` dialog listing packs with column counts and a preview of the first several column names.
- `src/lib/review/types.ts`: `REVIEW_MAX_COLUMNS` 12 to 40.
- Rollback is unchanged: `REVIEW_TABLES_ENABLED = false` removes the tab; all edits stay inside `review_*` files.
