# PDF browser native capability validation

Reference GenOffice revision: 476e5023c9a4bc459ca6de7b1d697ab25d94850e.
Pinned browser engine: @embedpdf/pdfium 2.15.1 (same package family used upstream).
Publisher documentation: https://www.embedpdf.com/docs/pdfium/getting-started

Implemented browser operations include genuine source text replacement/deletion,
source image insert/replace/crop/transform/rotate/flip/opacity/delete, persistent inserted
text authoring/edit/move/delete, scoped markup removal, native headers/footer/watermarks,
blank pages/canvas sizing/crop, bookmark reads/navigation, attached-source page merge/
replacement, and separate native page extraction/split downloads. Existing annotations,
forms, text search, page review and revision/undo controls remain available.

This is not a claim of complete upstream parity. The README explicitly records limits:
source paragraph/block reflow, arbitrary embedded-font extension, nested form editing,
new reply threads/freeform form marks, arbitrary markup styles, external image services,
OCR/redaction/signing and general new-document authoring from a prompt are not added. Extract/split create separately persisted Library PDFs with authenticated download links and same-workspace retry receipts.
These are not simulated through overlays or renamed downloads.

Native evidence: src/lib/office/pdf-native.test.ts exercises the exact WASM dependency,
serialized PDF bytes, independent PDF.js text extraction, and actual PDFium raster pixels.
It caught and corrected a generic fill-alpha API that returned success while writing no
image alpha. Current opacity uses a scoped native ExtGState and preserves source pixels,
including restoring original appearance after opacity zero. Transparent source-image
crop appearance is covered. Existing concurrency/annotation/admission tests are rerun.

The native worker is a local emitted Vite asset. Both publisher and PDFium third-party
licenses ship in public/licenses. No external PDF processing endpoint or generated-image
service is introduced. PDF byte transport uses the shared authenticated staged-save/
direct-read helpers and preserves the existing save idempotency token.

Completed local acceptance: the production build emits the self-hosted WASM worker/asset. A live browser agent inspected and replaced original source text, reread it and both notes, saved revision 5 and reloaded it. Independent PDF.js extraction confirmed exact text, page geometry and both notes. The authenticated server-backed Download PDF route produced an actual browser download event. Remaining acceptance: independent viewer inspection of real source documents/complex fonts and AWS runtime checks. The local text-only model cannot perform visual inspection.
No AWS deployment has been performed by this PDF implementation task.
