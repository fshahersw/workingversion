# Writer native tool validation

This pass ports the browser-compatible Writer operations from GenOffice `476e5023c9a4bc459ca6de7b1d697ab25d94850e`, retaining its MIT attribution, into the existing native DOCX editor. It preserves the platform's read/write policies, stale-document checks, revision save controls and rollback ownership checks.

`bun test src/lib/writer/native-agent-tools.test.ts` passes **16 tests**. These use real ProseMirror transactions and the production DOCX serializer/parser with synthetic packages; they do not certify rendering in desktop Microsoft Word.

Verified native output:

- Exact highlighted deletion/replacement preserves surrounding text; stale captured selections refuse edits. Explicit whole-body clear is a different operation, leaves a valid editable paragraph and preserves final page settings. Whole-body replacement starts with new body formatting/source identities so old paragraph page breaks and indents cannot leak into unrelated content.
- Invalid operation batches, including unsafe link schemes, leave the document unchanged. Tracked insertion at the beginning creates native insertion marks.
- Comments preserve the live cursor; their saved DOCX contains real comment ranges and comment content. Deletion removes the selected anchors. Inline replacement preserves the existing comment mark.
- Native endnote edits retain bold/italic rich runs. Deleting that endnote removes its references while an unrelated footnote remains.
- Named style patches preserve unrelated font slots, spacing attributes, keep-next, priority/rsid and custom XML. Pending preview and native save resolve the same style definitions. Inheritance cycles fail validation.
- Invalid or overflowing drawing lengths fail validation; negative picture sizes are rejected rather than silently clamped.
- A native editable textbox emits `wp:anchor` and `w:txbxContent`.
- A focused text edit preserves **24 tables byte for byte**, plus a real chart's native chart XML, relationships and embedded XLSX byte for byte. The chart remains editable; it is not a raster diagram.
- Requested-page context is bounded and retains block spans across pages. Mode policy exposes reads in Ask and excludes mutations.

Operational boundaries:

- `write_document` accepts supplied restricted HTML; it does not launch an upstream nested model generation. Use `replace:true` only for an explicitly requested entire-body replacement. Selection and page requests must not be widened to a whole document.
- The page map comes from current browser pagination. It is cleared by document-identity mismatch, limited to one current/requested page, and is not Word layout certification.
- New section breaks use native section XML and settings. A second pending break or ambiguous new-block section requires Save and a fresh read to preserve header/section ownership.
- Pictures use the approved existing image-fetch path, with document/readonly checks after asynchronous fetch. PNG/JPEG/GIF, page/paragraph anchors, and the declared wrapping options are supported; margin anchors are rejected.
- Text watermarks use the existing native defaults. Picture/custom-style watermark options and generic remote `analyze_media` are not implemented.
- Existing unsupported/protected drawing content is preserved. These tests establish no universal SmartArt, tracked table, floating-layout or desktop pagination equivalence.

The additional state participating in Writer failure rollback now includes comments, pending style definitions, watermark and trailing section-break type. As with body edits, a concurrent manual change prevents automatic whole-document rollback from replacing that new state.
