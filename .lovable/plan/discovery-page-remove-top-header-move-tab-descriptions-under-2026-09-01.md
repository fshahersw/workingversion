# Discovery page: remove top header, move tab descriptions under uploaders

## Goal
Remove the "Discovery" title, subtitle, and orange icon from the top of the Discovery workspace so the tab content sits higher. Replace that lost context with a short, tab-specific description placed underneath each tab's file upload panel.

## Changes

1. `src/components/docs/DocsWorkspace.tsx`
   - Remove the `<header>` block entirely (icon, "Discovery" `<h1>`, and subtitle paragraph).
   - Keep the `Tabs` shell and `TabsList`; the page should still show the "Summarize" and "Depositions" tab triggers.
   - Reduce top padding if needed so content starts higher.

2. `src/components/summarize/SummarizeView.tsx`
   - In the idle state (`!started`), render a short description directly under the `DropPanel`.
   - Suggested copy: "Upload PDFs, Word, Excel, PowerPoint, or text files. Search across them or ask a question grounded in the text."
   - Keep the existing animation and layout; only insert a compact text line below the drop panel.

3. `src/components/summarize/DepositionView.tsx`
   - In the idle state (the `DepositionDropPanel` branch), render a short description directly under the drop panel.
   - Suggested copy: "Upload deposition transcripts. The AI extracts witness details, page:line citations, and cross-transcript patterns."
   - Keep the existing animation and layout.

## Acceptance criteria
- [ ] The Discovery page no longer shows the orange icon or "Discovery" header text.
- [ ] The Summarize tab's idle state shows a one-line description under the upload panel.
- [ ] The Depositions tab's idle state shows a one-line description under the upload panel.
- [ ] Tab switching, upload flow, and responsive layout remain unchanged.
- [ ] No backend or auth changes.
