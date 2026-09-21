# PDF workspace

The browser workspace uses existing authenticated Office document APIs and immutable
S3 revisions. PDF.js renders and reads the PDF page tree. pdf-lib creates actual PDF
annotations, form values, page changes and editable inserted text. A self-hosted, pinned
@embedpdf/pdfium 2.15.1 WASM worker edits actual source text/image objects. The shared AgentLoop executes
tools against the current document through the shared Office inference endpoint.

## Supported

- Read/search text with current physical page citations; capture one rendered page
  for visual review (at most 1400 pixels along its longest edge).
- Native notes and highlights anchored to a unique exact quote. Highlights cover
  whole intersecting text runs, not invented per-character glyph bounds.
- Paginated native annotation readback, exact current-revision ids, author/text/color
  and explicit editing restrictions. Update text or color and remove notes and text
  markups, preserving source text and safely cleaning an attached popup. Locked,
  threaded, shared, oversized or unsupported annotations are preserved.
- Edit, Ask and Review modes. Ask/Review advertise read tools and independently
  reject mutations in their executable handlers. Focused review/annotation/form/
  verification guides and bounded active-page/selected-text context assist the agent.
- Persistent inserted text blocks: add/edit/move/delete using native stream identities,
  standard Helvetica/Times-Roman/Courier fonts, wrapping, color and size. Manual text
  insertion uses the same editable blocks. Headers/footer/page-number templates and
  horizontal translucent watermarks replace only matching workspace-created blocks.
- Native source object inventory and revision-scoped IDs. Exact source text replacement
  retains the original font/matrix and checks glyph availability and serialized text.
  Remove selected text/image objects; transform, rotate, flip and recolor supported objects.
  These operations are not certified redaction.
- PNG/JPEG insertion/replacement, image-only pixel cropping at source dimensions,
  and independent absolute image opacity. Opacity uses a native graphics-state wrapper
  around a uniquely generated image mark because PDFium's generic fill-alpha setter
  does not persist image alpha. Tests render actual pixels at opacity .5, 0 and 1.
- Native blank-page insertion, page-size/crop edits, outline read/navigation, selected-page
  merge/replacement, and ordered extraction/split to separate Library PDFs with authenticated download links.
  Page-size changes resize the canvas without scaling content. Cropping only hides it.
- Text, checkbox, dropdown and radio form values.
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

No permanent redaction, OCR, digital signing, Office conversion, external image
search/generation/background-removal service, arbitrary font embedding, source paragraph
reflow or certified export fidelity. Source edits currently support top-level text/images;
nested form objects, paths and unsupported embedded-font glyphs are preserved/rejected.
Source text editing is not full GenOffice PDFium/Harfbuzz layout-engine parity. Threaded
annotation replies, free-form form marks, arbitrary markup creation styles, rich source
text block reflow and general new-PDF authoring from a prompt remain gaps. Extraction/split create separately persisted native PDFs and reuse completed receipts on retry.
Existing PDF creation/import UI and editable inserted blocks work natively.
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
src/lib/office/pdf-annotations.test.ts exercises actual native comment/markup updates,
popup cleanup, author/geometry preservation, pagination/truncated-note protection,
direct annotation indexes across atomic batches, read-only tools, stale revisions
and mode changes before commit.

After production build, run: node scripts/verify-pdf-build.mjs

That check copies the emitted parser and traced dependencies to an isolated temporary
directory and verifies actual canvas, worker/font/CMap/WASM assets and PDF extraction.
It cannot accidentally resolve repository dependencies. Build on the target operating
system/architecture: Windows native canvas cannot run on Lambda Linux. Deployment
requires the same check inside the matching Linux runtime plus browser, provider,
multi-tab and independent-viewer compatibility acceptance tests.

## Provenance

No GenOffice PDF desktop implementation was copied into this module. Its pinned
PDFium dependency and public APIs informed this independent browser adapter.
Dependency: @embedpdf/pdfium 2.15.1, exact in package.json/bun.lock. The worker imports
pdfium.wasm as a local Vite asset; no CDN or external document processing is involved.
Publisher MIT license and PDFium/third-party notices are shipped in
public/licenses/embedpdf-pdfium-2.15.1-MIT.txt and public/licenses/pdfium-2.15.1-notices.txt.
The PDFium notice file, not a current website licensing summary, governs the pinned binary. Shared GenOffice
AgentLoop/UI retains its existing upstream licensing. text-layer.css is the text-layer
excerpt from PDF.js 5.7.284 viewer CSS, with Mozilla's copyright preserved. PDFJS-LICENSE
contains Apache 2.0. pdf-lib/PDF.js remain dependencies under their package licenses.


## Native worker and attachment bounds

At most two native workers run together, with eight queued requests. Each worker is
terminated on cancellation/error/30-second timeout. A request inspects at most five
pages (5000 top-level objects per page; two million text characters total) and applies
at most 50 native operations. Tool inventories return paginated <=40,000-character
JSON batches. Image decoding is bounded to 10 MB, 8192 pixels per side, 16 megapixels;
a mutation batch accepts <=64 MB decoded pixels. These are application bounds, not
a claim of hard WASM heap isolation. Main-thread PDF admission still parses bytes.

Attach at most eight local PDF/PNG/JPEG files totaling 64 MB. They remain in browser
memory and disappear when leaving the workspace. No external URL fetch is accepted.
Split prepares at most three files / 30 MB total per call so each retains a visible
fallback download link. A prepared link does not prove browser download completion.
Large saved revisions use authenticated direct grants and staged transfers rather than
passing document bodies above 3 MB through the Lambda response/request path.

src/lib/office/pdf-native.test.ts runs the exact pinned WASM on real PDFs and separately
reads serialized text with PDF.js. It verifies source replacement/deletion, atomic
rejection, font/matrix/source preservation, native image edits and rendered opacity,
transparent-image cropping, persistent inserted text, decorations, page assembly,
outline handling, scoped markup removal and truthful download offers. Its worker
cancellation test uses a controlled browser-worker stand-in; browser asset loading and
live tool execution still require the production browser acceptance run.
