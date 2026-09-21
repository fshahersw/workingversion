# Slides native operation parity

Implemented against the pinned GenOffice source `476e5023c9a4bc459ca6de7b1d697ab25d94850e` on 2026-09-21. This is a browser/native-engine port; it adds no external research or media-generation service and changes no provider configuration.

## What is executable

The existing `apply_ops` tool now exposes all eleven previously missing operation names, backed by retained native handlers and the same document transaction, history and save pipeline:

| Operations | Native result and boundary |
|---|---|
| `alignElements`, `distributeElements` | Arranges top-level frames in numeric EMU, relative to selection or slide; preserves text/styles and updates linked connectors. Group children are rejected. |
| `addConnector` | Creates an editable, attached native connector with bounded width, arrowheads and optional dash. Supports unrotated/unflipped rectangular, rounded-rectangle, ellipse, text, picture and group endpoints. Unsupported/custom connection geometry is rejected rather than guessed. |
| `addSlideWithLayout`, `setSlideLayout` | Resolves current package or offered built-in layout by name, index or path. Built-ins materialize inside the transaction snapshot; dry runs do not create parts. A new slide returns its durable ID; read the new placeholders before filling them. |
| `insertEquation` | Inserts a native OfficeMath paragraph into existing text or a new textbox. Preserves OMML through save/reopen and unrelated text edits. Browser preview uses linearized fallback text; it does not establish PowerPoint typesetting fidelity. |
| `addAnimation`, `removeAnimation`, `reorderAnimation` | Uses actual timeline positions and native effect/timing XML. Unknown imported effects are preserved when incremental editing is possible. Advanced timing graphs that require a lossy rebuild are refused atomically. Raw preset XML creation is unavailable to the agent. |
| `setShapeCustomGeometry` | Writes editable native path commands with finite, bounded coordinates, including direct group children. |
| `setTableStyle` | Applies real fixed-color presets, built-in style names/IDs and explicit look flags; validates booleans, width and selected cells. Border color/width require explicit `borderPreset:"all"`. Trusted UI shims retain their legacy payload, but raw style XML is rejected from model calls. |

`read_slide({slideIndex, include_native:true})` now reads actual layout identities, animation sequence numbers (including orphan targets), native table style IDs/flags, notes and comments through the read-only `slides:read-native-details` engine route. Returned counts indicate bounded inventories. Document content remains untrusted evidence. No new top-level inference allowlist entry is needed.

The model-facing guide contains 61 callable operation names, matching this pinned upstream inventory. Operation-name parity does **not** assert identical support for every optional upstream field or arbitrary imported file. The batch limit is now accurately 50, matching `slides:apply-txn`; dependent creation/read/edit stages must use separate calls. Ask and Review modes continue to hide and reject `apply_ops` through the actual companion skill. Hidden internal operations are rejected even if a model guesses their names.

## Verification

Result: **11/11 native parity tests, 9/9 browser/policy/QC tests and 8/8 existing native package-fidelity tests passed**. The retained worker build passed. The integrated full TypeScript run passed after all Writer changes were completed.

- `node --test services/office-engine/server/slides-native-parity.test.mjs`: real retained handlers create PPTX fixtures, apply edits, save ZIP bytes and reopen them. Covers all eleven operations, unchanged package parts, style flags, attached ellipse endpoints following movement, equation preservation and explicit replacement, new-layout rollback, unknown imported effect preservation, unsupported-geometry rejection and protection against forged equation markers.
- `node --import ../analysis/resolve-typescript.mjs --experimental-strip-types --test src/lib/office/slides-insertion.test.ts src/lib/office/slides-qc.test.ts`: actual renderer skill/schema dispatch, dynamic Ask/Review revocation, read-only native inventories, rejected raw style payloads and batch limits, and preservation of explicit textbox geometry during automatic QC.
- Canonical/retained drift checks cover eight PPTX engine modules and all six operation guide files. The worker build compiles the actual retained handlers.

These tests use synthetic documents and no provider/AWS calls. They establish native write/read behavior for the fixtures, not universal Office compatibility. Before release, run the production Bedrock browser workflow, save/reload/download through the deployed engine, and open representative generated and imported PPTX files in Microsoft PowerPoint to check native equations, animation playback, connectors, masters and table styles. No deployment was performed in this pass.

## Source provenance

- [Upstream operation handlers](https://github.com/genspark-ai/genoffice/tree/476e5023c9a4bc459ca6de7b1d697ab25d94850e/packages/pptx-ops/src/ops): narrowly ported arrangement, equation/linearization, animation and geometry handlers; adapted to retained engine imports and guarded browser inputs.
- [Upstream PPTX engine](https://github.com/genspark-ai/genoffice/tree/476e5023c9a4bc459ca6de7b1d697ab25d94850e/packages/pptx-engine/src): native animation preservation, custom geometry, connector-site mapping, table look flags/gallery lookup, and targeted OfficeMath parsing/writing.
- [Retained handlers](../services/office-engine/vendor/slides/src/main/ops/index.ts), [browser tool dispatch](../src/office/slides/src/renderer/ai/slides-skill.ts), [native tests](../services/office-engine/server/slides-native-parity.test.mjs).
