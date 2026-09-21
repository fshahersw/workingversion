// ============================================================================
// Contrastive tool descriptions (pure, shared by Office renderers and the
// research server).
//
// The same shape the TypeSafe questions use for options — what a tool is FOR,
// what it is NOT for, and examples — appended to every tool description. A
// model choosing between 20-40 tools picks by contrast, not by definition, and
// the "not for" line is what stops the classic misses (insert_footnote called
// twice for one authority; view_page used to read text; web_search used where
// a structured source exists). Keep entries short; the original description
// still carries the argument semantics.
// ============================================================================

export type ToolContrast = {
  use: string;
  notFor: string;
  examples?: readonly string[];
};

export type ContrastMap = Readonly<Record<string, ToolContrast>>;

/** Render the appended block for one tool. */
export function contrastText(c: ToolContrast): string {
  const ex = c.examples?.length ? ` Examples: ${c.examples.map((e) => `"${e}"`).join("; ")}.` : "";
  return `\nUse for: ${c.use}. Not for: ${c.notFor}.${ex}`;
}

/** Append contrast blocks to matching tools; tools without an entry are returned as-is. */
export function withToolContrast<T extends { name: string; description: string }>(
  tools: readonly T[],
  map: ContrastMap,
): T[] {
  return tools.map((t) => {
    const c = map[t.name];
    if (!c || t.description.includes("\nUse for: ")) return t;
    return { ...t, description: `${t.description.trimEnd()}${contrastText(c)}` };
  });
}

// --- Writer ----------------------------------------------------------------------

export const WRITER_TOOL_CONTRAST: ContrastMap = {
  read_document_outline: {
    use: "enumerating every block of a long document, including the middle the context list elided",
    notFor: "reading a block's full text (read_blocks) or finding a phrase (search_document)",
    examples: ["list every heading in this 80-page brief", "what is at blocks 140-180?"],
  },
  search_document: {
    use: "locating literal text anywhere in the document, with exact spans and counts, before an edit",
    notFor: "semantic review or summarizing (read the blocks), or counting footnotes/headings (audit_document)",
    examples: ["where does 'learned intermediary' appear?", "how many times is the defendant named?"],
  },
  audit_document: {
    use: "a deterministic structure/format self-check before declaring an editing task done",
    notFor: "how the page looks (view_page) or Bluebook form (check_bluebook_citations)",
    examples: ["is the document clean?", "did my footnotes all land?"],
  },
  view_page: {
    use: "seeing rendered layout: overflow, spacing, alignment, page balance, table fit",
    notFor: "reading or counting content, headings, colors or margins (read_blocks / audit_document are exact)",
    examples: ["does the exhibit table fit the page?", "is there an orphan heading at a page bottom?"],
  },
  get_document_context: {
    use: "refreshing block indexes after a change before the next index-addressed edit",
    notFor: "reading text (read_blocks) or checking structure (audit_document)",
    examples: ["I inserted three blocks; what are the new indexes?"],
  },
  read_blocks: {
    use: "the full text of the blocks you are about to rewrite, translate or condense",
    notFor: "writing (replace_blocks/insert_content) or the whole document at once (page it)",
    examples: ["read blocks 12-15 before rewriting the argument"],
  },
  insert_content: {
    use: "adding NEW blocks at a position: sections, paragraphs, lists, an HTML table",
    notFor: "changing existing text (replace_blocks), formatting only (apply_commands), or styled tables with widths (insert_table)",
    examples: ["add a Statement of Facts after block 3", "append a signature block"],
  },
  replace_blocks: {
    use: "rewriting, translating, condensing or expanding existing blocks in place",
    notFor: "a few words inside a sentence (apply_commands replaceAllText), or new content (insert_content)",
    examples: ["rewrite blocks 8-10 in plain English", "condense the conclusion to one paragraph"],
  },
  apply_commands: {
    use: "formatting, styles, heading levels, find & replace, delete/move blocks, list conversion, TOC — deterministic batch edits",
    notFor: "composing new prose (insert_content) or page layout (set_page_setup)",
    examples: ["make all level-2 headings bold 12pt", "replace 'Defendant Corp' with 'Acme' everywhere (expectedOccurrences)"],
  },
  read_revisions: { use: "listing pending tracked changes", notFor: "accepting or rejecting them (the user does that in Review)" },
  read_comments: { use: "the full comment thread list including resolved ones", notFor: "acting on a comment (reply_comment / resolve_comment)" },
  reply_comment: { use: "answering a comment thread or reporting the change it asked for", notFor: "editing the document itself" },
  resolve_comment: { use: "closing a thread after its change is applied or when asked", notFor: "closing threads you did not address" },
  web_search: {
    use: "current facts, figures or references the document needs from the web",
    notFor: "legal authority you will cite (verify_citations / fetch_page the source) or images (image_search)",
    examples: ["current FDA labeling requirements for boxed warnings"],
  },
  image_search: { use: "finding a photo or illustration to insert", notFor: "charts (insert_chart) or diagrams (render_diagram)" },
  insert_image: { use: "placing an image handle or URL into the document", notFor: "creating images (generate_image) or charts (insert_chart)" },
  generate_image: { use: "an original illustration, icon or cover art", notFor: "real people, trademarks, diagrams (render_diagram) or data charts (insert_chart)" },
  insert_chart: {
    use: "a native chart from REAL numbers already in the document or a source",
    notFor: "illustrative numbers (say so and use a table), or editing a chart (edit_chart)",
    examples: ["bar chart of pending actions by district from the table in block 9"],
  },
  edit_chart: { use: "changing an existing chart's title, labels or values", notFor: "adding data points (insert a new chart) or styling text" },
  insert_table: {
    use: "a NEW native table with column widths and a firm style preset",
    notFor: "editing cells of an existing table (edit_table) or repeat-header/borders (set_table_properties)",
    examples: ["privilege log with Bates, Date, Custodian, Description, Basis columns"],
  },
  insert_page_break: { use: "starting a new page for a cover, TOC, exhibit or signature page", notFor: "spacing (paragraph spacing) or section-level layout changes (set_page_setup)" },
  edit_table: {
    use: "cell text and one row/column add or delete on an existing table, or a restyle preset",
    notFor: "repeat header rows, alignment, width, borders, merges (set_table_properties) or a new table (insert_table)",
  },
  set_header_footer: { use: "header/footer text and page-number fields", notFor: "body content or page margins" },
  set_page_setup: {
    use: "orientation, paper size, margins, columns — decide this BEFORE drafting a filing (applyTo 'all')",
    notFor: "a court's typography rule as a whole (apply_court_style) or table widths",
    examples: ["letter, portrait, 1-inch margins for the whole document", "landscape for the exhibit section only"],
  },
  set_table_properties: {
    use: "repeat header rows, table alignment/width, autofit, border scheme, cell padding, merges",
    notFor: "cell text (edit_table) or fill presets (edit_table restyle)",
    examples: ["repeat the header row of the exhibit list on every page", "make the schedule 100% of the text width"],
  },
  insert_footnote: {
    use: "adding ONE new note for an authority cited for the first time",
    notFor: "an authority already footnoted (use Id./supra in a new note), editing an existing note, or moving a mark",
    examples: ["footnote Hardeman after the sentence ending 'as a matter of law.'"],
  },
  check_bluebook_citations: {
    use: "mechanical Bluebook FORM findings with drop-in fixes before finishing a draft that cites authority",
    notFor: "confirming a case exists or what it holds (verify_citations, then read the source)",
  },
  apply_court_style: {
    use: "the forum's typography rule for the whole filing, with its verification note",
    notFor: "one-off font changes (apply_commands) or margins alone (set_page_setup)",
    examples: ["format this brief for S.D.N.Y.", "what does FRAP 32 require? (dryRun)"],
  },
  create_document: { use: "producing a SEPARATE new file in the Library", notFor: "changing the open document" },
};

// --- Sheets ----------------------------------------------------------------------

export const SHEETS_TOOL_CONTRAST: ContrastMap = {
  get_workbook_context: { use: "sheet ids, extents, headers and the selection before any addressed operation", notFor: "cell values (read_range) or formats (read_formats)" },
  read_range: {
    use: "the values/formulas of a bounded block you are about to reason about or edit",
    notFor: "thousands of rows to filter or total by hand (query_range / aggregate_range are exact and instant)",
    examples: ["read A1:H40 to see the log's shape"],
  },
  aggregate_range: { use: "sums, counts, distinct values and frequencies of a column without reading it", notFor: "writing results into cells (query_range with target)" },
  load_guide: { use: "the field table for an operation family before first using it", notFor: "general questions (answer directly)" },
  read_formats: { use: "number formats, fonts, fills and widths of a range", notFor: "values (read_range)" },
  read_sheet_features: { use: "tables, filters, validations, conditional formats, charts present on a sheet", notFor: "cell content" },
  read_cells: { use: "a handful of specific cells", notFor: "a rectangular block (read_range)" },
  find_cells: { use: "locating cells by text or value across a sheet", notFor: "filtering rows into a result block (query_range)" },
  select_range: { use: "highlighting a range for the user", notFor: "any change to cells" },
  trace_precedents: { use: "what a formula depends on", notFor: "what depends on a cell (trace_dependents)" },
  trace_dependents: { use: "what breaks if a cell changes", notFor: "a formula's inputs (trace_precedents)" },
  propose_operations: {
    use: "every change to the workbook: values, formulas, ranges, formats, widths, tables, charts, query_range/import_file, finish_table",
    notFor: "reading (read_* tools) or producing a separate file (create_document)",
    examples: ["after building a log, finish_table on its range so columns fit their content"],
  },
  create_document: { use: "a SEPARATE new file in the Library", notFor: "changing the open workbook" },
};

// --- Slides ----------------------------------------------------------------------

export const SLIDES_TOOL_CONTRAST: ContrastMap = {
  read_slide: { use: "exact element ids, geometry, colors and full text of ONE page before editing it", notFor: "the deck overview (already in context) or visual checks (the layout audit runs on edits)" },
  execute_slide_script: { use: "moving, resizing, aligning, restyling or retexting EXISTING elements on one page in one script", notFor: "adding/deleting elements or pages (apply_ops) or regenerating a page" },
  web_search: { use: "facts and figures with sources for slide content", notFor: "images (image_search)" },
  image_search: { use: "a web image to place with insert_web_image", notFor: "generated art (generate_image)" },
  generate_image: { use: "original imagery matched to the deck's style", notFor: "charts (apply_ops addChart) or real people/trademarks" },
  analyze_media: { use: "describing an image the user attached", notFor: "text attachments (read them directly)" },
  insert_web_image: { use: "placing an image_search result on a page", notFor: "replacing an existing picture (replace_image)" },
  replace_image: { use: "swapping a picture in place, keeping frame and z-order", notFor: "adding a new picture" },
  ask_clarification: { use: "a genuine fork the user must decide (audience, scope, source of numbers)", notFor: "questions the context or a tool already answers" },
  plan_deck: { use: "an outline the user can approve before generation", notFor: "generating pages (generate_deck)" },
  regenerate_slide: { use: "redoing ONE page the user explicitly asked to redo", notFor: "tweaks (execute_slide_script / apply_ops)" },
  generate_deck: { use: "creating pages from a topic, pages list or attachments", notFor: "editing existing pages" },
  save_style_template: { use: "saving the current deck's style for reuse", notFor: "applying one (generate_deck style_template)" },
  list_style_templates: { use: "seeing saved styles", notFor: "anything else" },
  add_slide: { use: "one new layout-preserving blank page", notFor: "content generation (generate_deck) or deleting pages (apply_ops deleteSlide)" },
  edit_table_style: { use: "table banding, header style, borders", notFor: "cell text or structure (apply_ops setTableCell / tableStructure)" },
  edit_chart: { use: "an existing chart's series or labels", notFor: "a new chart (apply_ops addChart)" },
  apply_ops: {
    use: "every canonical edit as one atomic transaction: add/delete elements and pages, text, fonts, fills, tables, charts, backgrounds, notes, sections",
    notFor: "layout math across several existing elements (execute_slide_script) or generating a deck",
  },
  load_guide: { use: "an op group's field table and example before first use", notFor: "general questions" },
};

// --- Research agent (server) ---------------------------------------------------------

export const RESEARCH_TOOL_CONTRAST: ContrastMap = {
  web_search: {
    use: "authoritative web sources through curated, category-scoped domain sets; 1-4 categories in parallel",
    notFor: "structured primary data that has a dedicated tool (fda_search, federal_register_search, ecfr_search, search_pubmed, sec_search, clinicaltrials_search, db_*), or reading a page you already have (fetch_page)",
    examples: ["latest rulings in the talc MDL (mdl_class_action, legal_news, published_after)"],
  },
  fetch_page: {
    use: "reading a primary source in full after a search surfaced it; PDFs are read as text; blocked pages fall back to a rendering scraper",
    notFor: "a court filing's text (db_read_filing) or discovering sources (web_search)",
    examples: ["read the FDA warning letter page", "open the opinion PDF"],
  },
  verify_citations: {
    use: "confirming reporter citations resolve to real cases — call before finalizing ANY legal citation in an answer or draft",
    notFor: "what a case holds (read it) or docket entries (db_*)",
    examples: ["verify every cite in this paragraph before the memo goes out"],
  },
  fda_search: { use: "recalls, adverse events, labels from openFDA as structured records", notFor: "FDA press or guidance pages (web_search fda_drug_device) or trials (clinicaltrials_search)" },
  federal_register_search: { use: "proposed/final rules and notices as regulatory actions", notFor: "the operative CFR text (ecfr_search) or public comments" },
  ecfr_search: { use: "the current text of a CFR section", notFor: "rulemaking history (federal_register_search)" },
  search_pubmed: { use: "peer-reviewed studies for general and specific causation", notFor: "trial registrations (clinicaltrials_search) or news" },
  sec_search: { use: "a public defendant's own disclosures in EDGAR filings", notFor: "news about the company (web_search company_business)" },
  clinicaltrials_search: { use: "trial records: status, phase, sponsor, indication", notFor: "published results (search_pubmed)" },
  run_python: { use: "exact arithmetic, date math, aggregation over data pasted in the code", notFor: "retrieval, legal reasoning or anything needing the network" },
  read_document: { use: "reading an attached document by page", notFor: "web pages (fetch_page) or filings (db_read_filing)" },
  create_document: { use: "a downloadable report or memo once the research is done", notFor: "chat answers" },
  db_find_case: { use: "resolving a case name or docket number to a docket", notFor: "reading its entries (db_docket_sheet)" },
  db_docket_sheet: { use: "the docket entries of a known case", notFor: "full-text search across filings (db_search_filings)" },
  db_search_filings: { use: "finding filings by topic across dockets", notFor: "reading one filing (db_read_filing)" },
  db_read_filing: { use: "the text of one filing", notFor: "web pages (fetch_page)" },
  db_get_case: { use: "case metadata: court, judge, parties, status", notFor: "docket entries" },
  db_calendar: { use: "upcoming deadlines and hearings", notFor: "past rulings" },
  db_graph_ask: { use: "relationship questions across the docket graph", notFor: "simple lookups (db_get_case)" },
  matter_corpus_search: { use: "the firm's ingested matter documents", notFor: "the public web (web_search)" },
};

// --- Platform tools shared by the Office apps -----------------------------------------

export const PLATFORM_TOOL_CONTRAST: ContrastMap = {
  load_attachment_for_python: { use: "staging an attachment's bytes for run_python", notFor: "reading it as text (read the attachment)" },
  get_diagram_source: { use: "the source of a diagram already in the document", notFor: "creating one (render_diagram)" },
  run_python: { use: "exact computation and data transforms; write CSVs for import_file", notFor: "retrieval or legal reasoning" },
  verify_citations: { use: "confirming reporter citations resolve to real cases — call before finalizing ANY legal citation", notFor: "citation form (check_bluebook_citations) or holdings (read the source)" },
  fetch_page: { use: "reading one URL's main text", notFor: "discovering sources (web_search)" },
  search_firm_knowledge: { use: "the firm's internal knowledge base", notFor: "the public web" },
  search_library: { use: "documents already in the Library", notFor: "the public web or the open document" },
  load_firm_guide: { use: "house style and practice guides before drafting in that genre", notFor: "general questions" },
  ask_clarification: { use: "a genuine fork the user must decide", notFor: "anything the document or a tool answers" },
  generate_image: { use: "original illustration", notFor: "charts, diagrams, real people or trademarks" },
  edit_image: { use: "modifying a generated or attached image", notFor: "new imagery (generate_image)" },
  render_diagram: { use: "Graphviz/Mermaid flowcharts, timelines, org charts from text", notFor: "data charts (insert_chart / addChart) or photos" },
  list_templates: { use: "seeing saved document templates", notFor: "applying one (apply_template)" },
  apply_template: { use: "starting from a saved template", notFor: "ad-hoc formatting" },
  save_template: { use: "saving the current document as a template", notFor: "saving the document itself" },
};
