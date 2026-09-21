# PDF workspace

The browser workspace uses existing authenticated Office document APIs and immutable
S3 revisions. PDF.js renders and reads the PDF page tree. pdf-lib creates actual PDF
annotations, form values, page changes and new text. The shared AgentLoop executes
tools against the current document through the shared Office inference endpoint.

## Supported

- Read/search text with current physical page citations; capture one rendered page
  for visual review (at most 1400 pixels along its longest edge).
- Native notes and highlights anchored to a unique exact quote. Highlights cover
  whole intersecting text runs, not invented per-character glyph bounds.
- New bounded Helvetica lines; text, checkbox, dropdown and radio form values.
- Page rotation. Reorder/delete only when links, bookmarks, page labels and tagged
  structure will not be invalidated; deletion also rejects documents with forms.
- Session undo, explicit immutable revision saves, native PDF download, persisted chat.

Editing tools require the current edit revision. Each operation batch changes a
detached copy and publishes only on success. Manual edits are disabled during a
task. Interrupted/failed tasks restore their own starting bytes, preserving earlier
user edits. A save retry reuses version, bytes and idempotency key. Navigation and
unload guards warn about unsaved changes. Reordering materializes inherited fonts
and geometry before reparenting page leaves. Added content must fit the effective
CropBox/MediaBox intersection.

## Limits and release gates

No existing-text replacement, permanent redaction, OCR, digital signing, Office
conversion, merge, arbitrary font embedding or certified export fidelity.
Signed/encrypted PDFs, active content, attachments and XFA are refused, rather than
silently removed. Empty text does not prove an empty page. Reading order within a
page follows PDF.js text items; columns, tables and unusual fonts need visual checks.

Admission: 30 MB, 500 pages, 50-inch page edges, standard UserUnit and bounded parsed
object complexity. Extraction: 500 pages, 5 million characters and a 30-second task
deadline. These limits do not provide hard process isolation against malicious
parser CPU/memory or decompression attacks. Parser isolation and adversarial fixture
coverage remain release-hardening gates. Undo is session-local, 10 snapshots / 64 MB.
Prior saved revisions remain in history; this is not a sensitive-data removal workflow.

## Validation

The PDF tests in src/lib/office/pdf.test.ts cover page-tree/object-order disagreement,
hex/compressed text, native edits, inherited resources, atomic errors, form roundtrips,
direct/indirect active actions, linked structures, crop coordinates, stale revisions,
cancellation and missing text coverage.

After production build, run: node scripts/verify-pdf-build.mjs

That check copies the emitted parser and traced dependencies to an isolated temporary
directory and verifies actual canvas, worker/font/CMap/WASM assets and PDF extraction.
It cannot accidentally resolve repository dependencies. Build on the target operating
system/architecture: Windows native canvas cannot run on Lambda Linux. Deployment
requires the same check inside the matching Linux runtime plus browser, provider,
multi-tab and independent-viewer compatibility acceptance tests.

## Provenance

No GenOffice PDF desktop implementation was copied into this module. Shared GenOffice
AgentLoop/UI retains its existing upstream licensing. text-layer.css is the text-layer
excerpt from PDF.js 5.7.284 viewer CSS, with Mozilla's copyright preserved. PDFJS-LICENSE
contains Apache 2.0. pdf-lib/PDF.js remain dependencies under their package licenses.
