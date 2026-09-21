// ============================================================================
// Deterministic Writer format/structure audit (pure; no model, no rendering).
//
// The Slides analog (layout-audit.ts) reads the render tree for overlap and
// overflow. Word documents fail differently: a footnote defined twice for one
// authority, a heading faked with inline bold, grey citation text, a table
// wider than the text area, runs of empty paragraphs used as spacing. This
// module reads a plain block model extracted from the document (see the
// ProseMirror adapter in src/writer/renderer/ai/document-audit.ts) and returns
// human-readable findings the agent can act on before it declares a run done.
// ============================================================================

export type AuditNoteRef = { kind: "footnote" | "endnote"; id: string; num: number | null };

export type AuditRun = {
  text: string;
  bold: boolean;
  /** hex without '#', or null for automatic/black */
  color: string | null;
  link: boolean;
};

export type AuditBlockType = "paragraph" | "heading" | "listItem" | "table" | "protected" | "other";

export type AuditBlock = {
  index: number;
  type: AuditBlockType;
  /** heading level 1-6 */
  level?: number;
  /** plain text of the block (tables: all cells joined) */
  text: string;
  runs: AuditRun[];
  align: string | null;
  indentLeft: number | null;
  pageBreakBefore: boolean;
  /** tables only */
  tableWidthPx?: number | null;
  tableWidthPct?: number | null;
  noteRefs: AuditNoteRef[];
  /** tracked deletion: excluded from content checks */
  deleted?: boolean;
};

export type AuditSection = {
  pageWidth: number;
  pageHeight: number;
  marginTop: number;
  marginRight: number;
  marginBottom: number;
  marginLeft: number;
};

export type AuditModel = {
  blocks: AuditBlock[];
  footnotes: Array<{ id: string; text: string }>;
  endnotes: Array<{ id: string; text: string }>;
  section: AuditSection | null;
};

export const DOC_AUDIT_MAX_ISSUES = 12;
const TWIPS_PER_INCH = 1440;
const PX_PER_INCH = 96;
/** Word's paper sizes in twips (portrait); orientation swaps them. */
const PAPER: Array<[string, number, number]> = [
  ["Letter", 12240, 15840],
  ["Legal", 12240, 20160],
  ["A4", 11906, 16838],
  ["Executive", 10440, 15120],
  ["Tabloid", 15840, 24480],
];
const PAPER_TOLERANCE = 30;
const MARGIN_MIN = 0.5 * TWIPS_PER_INCH;
const MARGIN_MAX = 2.5 * TWIPS_PER_INCH;
const CONTENT_MIN = 3 * TWIPS_PER_INCH;

const BLACKISH = new Set(["", "000000", "auto", "000", "0d0d0d", "1a1a1a", "111111", "212121", "222222", "333333"]);

const inches = (twips: number) => `${Math.round((twips / TWIPS_PER_INCH) * 100) / 100}"`;
const list = (xs: number[], max = 6) => (xs.length > max ? `${xs.slice(0, max).join(", ")}, … (+${xs.length - max})` : xs.join(", "));
const words = (t: string) => t.trim().split(/\s+/).filter(Boolean).length;
const norm = (t: string) => t.replace(/\s+/g, " ").trim().toLowerCase();

function isBlank(b: AuditBlock): boolean {
  return (b.type === "paragraph" || b.type === "heading" || b.type === "listItem") && b.text.trim() === "" && !b.pageBreakBefore;
}

/** A body paragraph whose every visible run is bold and which reads like a title. */
function looksLikeBoldHeading(b: AuditBlock): boolean {
  if (b.type !== "paragraph" || b.deleted) return false;
  const visible = b.runs.filter((r) => r.text.trim());
  if (!visible.length) return false;
  if (!visible.every((r) => r.bold)) return false;
  const t = b.text.trim();
  if (t.length > 90 || words(t) > 12) return false;
  if (/[.!?;:]$/.test(t) && !/^[IVXLC]+\.$|^\d+\.$/.test(t)) return false; // a bold sentence is emphasis, not a heading
  return true;
}

export type AuditOptions = { structuralOnly?: boolean; baseline?: AuditModel };

function invalidGeometry(section: AuditSection | null): boolean {
  if (!section) return false;
  const { pageWidth: w, pageHeight: h, marginTop: top, marginRight: right, marginBottom: bottom, marginLeft: left } = section;
  return ![w, h, top, right, bottom, left].every(Number.isFinite) || w <= 0 || h <= 0
    || [top, right, bottom, left].some(m => m < 0) || w - left - right <= 0 || h - top - bottom <= 0;
}

/** Style heuristics are advisory; only broken references/geometry force correction. */
export function auditDocumentModel(model: AuditModel, options: AuditOptions = {}): string[] {
  const issues: string[] = [];
  const structural: string[] = [];
  const structuralIssue = (message: string) => { issues.push(message); structural.push(message); };
  const blocks = model.blocks.filter((b) => !b.deleted);

  // --- 1. Footnote / endnote parity --------------------------------------------
  for (const kind of ["footnote", "endnote"] as const) {
    const defs = kind === "footnote" ? model.footnotes : model.endnotes;
    const priorDefs = options.baseline ? kind === "footnote" ? options.baseline.footnotes : options.baseline.endnotes : [];
    const priorRefs = options.baseline?.blocks.filter(b => !b.deleted).flatMap(b => b.noteRefs.filter(r => r.kind === kind)) ?? [];
    const priorOrphans = new Set(priorDefs.filter(d => !priorRefs.some(r => r.id === d.id)).map(d => d.id));
    const priorMissing = new Set(priorRefs.filter(r => !priorDefs.some(d => d.id === r.id)).map(r => r.id));
    if (!defs.length && !blocks.some((b) => b.noteRefs.some((r) => r.kind === kind))) continue;
    const refs = blocks.flatMap((b) => b.noteRefs.filter((r) => r.kind === kind).map((r) => ({ ...r, block: b.index })));
    const refIds = new Map<string, number[]>();
    for (const r of refs) refIds.set(r.id, [...(refIds.get(r.id) ?? []), r.block]);
    const defIds = new Set(defs.map((d) => d.id));
    const orphans = defs.filter((d) => !refIds.has(d.id) && !priorOrphans.has(d.id));
    if (orphans.length) {
      structuralIssue(
        `Orphan ${kind}${orphans.length === 1 ? "" : "s"}: ${orphans.length} definition${orphans.length === 1 ? "" : "s"} (${orphans
          .map((d) => `"${d.text.trim().slice(0, 40)}${d.text.trim().length > 40 ? "…" : ""}"`)
          .slice(0, 3)
          .join("; ")}) ${orphans.length === 1 ? "has" : "have"} no reference mark in the body. Preserve the note's text; restore its intended reference from known context or report the detached note. Do not delete source content merely to silence the audit.`,
      );
    }
    const missing = refs.filter((r) => !defIds.has(r.id) && !priorMissing.has(r.id));
    if (missing.length) {
      structuralIssue(`Dangling ${kind} reference${missing.length === 1 ? "" : "s"} in block${missing.length === 1 ? "" : "s"} ${list([...new Set(missing.map((m) => m.block))])}: the mark points to no ${kind} text. Restore known source text or report the missing definition; never invent a note.`);
    }
    const dupRefs = [...refIds.entries()].filter(([, bs]) => bs.length > 1);
    if (dupRefs.length) {
      issues.push(`Duplicate ${kind} reference marks: ${dupRefs.length} note${dupRefs.length === 1 ? " is" : "s are"} referenced more than once (blocks ${list([...new Set(dupRefs.flatMap(([, bs]) => bs))])}).`);
    }
    const byText = new Map<string, string[]>();
    for (const d of defs) {
      const key = norm(d.text);
      if (key) byText.set(key, [...(byText.get(key) ?? []), d.id]);
    }
    const dupDefs = [...byText.entries()].filter(([, ids]) => ids.length > 1);
    if (dupDefs.length) {
      issues.push(
        `Duplicate ${kind} text: ${dupDefs.length} authorit${dupDefs.length === 1 ? "y is" : "ies are"} defined in more than one note (e.g. "${dupDefs[0]![0].slice(0, 50)}${dupDefs[0]![0].length > 50 ? "…" : ""}" ×${dupDefs[0]![1].length}). Cite it once in full and use a short form (Id. / supra) for later references.`,
      );
    }
  }

  // --- 2. Headings faked with inline bold ----------------------------------------
  const fakeHeadings = blocks.filter((b, i) => looksLikeBoldHeading(b) && blocks[i + 1] && (blocks[i + 1]!.type === "paragraph" || blocks[i + 1]!.type === "listItem") && blocks[i + 1]!.text.trim());
  if (fakeHeadings.length) {
    issues.push(
      `Bold paragraph${fakeHeadings.length === 1 ? "" : "s"} used as heading${fakeHeadings.length === 1 ? "" : "s"} in block${fakeHeadings.length === 1 ? "" : "s"} ${list(fakeHeadings.map((b) => b.index))} ("${fakeHeadings[0]!.text.trim().slice(0, 40)}"): advisory heuristic only. Apply a named Heading style only if the user's request identifies this as a heading; preserve intentional bold body text.`,
    );
  }

  // --- 3. Non-black text in body / citation text ----------------------------------
  const colored = new Map<string, number[]>();
  for (const b of blocks) {
    if (b.type !== "paragraph" && b.type !== "listItem") continue;
    for (const r of b.runs) {
      if (!r.text.trim() || r.link) continue;
      const c = (r.color ?? "").toLowerCase();
      if (BLACKISH.has(c)) continue;
      colored.set(c, [...(colored.get(c) ?? []), b.index]);
    }
  }
  if (colored.size) {
    const parts = [...colored.entries()].slice(0, 3).map(([c, bs]) => `#${c} in block${bs.length === 1 ? "" : "s"} ${list([...new Set(bs)], 5)}`);
    issues.push(`Colored body text: ${parts.join("; ")}. Advisory style observation only: preserve requested colors and the existing theme. Change color only when the user's request calls for it; color alone is not a structural defect.`);
  }

  // --- 4. Page geometry ------------------------------------------------------------
  const s = model.section;
  if (s) {
    const w = s.pageWidth;
    const h = s.pageHeight;
    const known = PAPER.some(([, pw, ph]) => (Math.abs(pw - w) <= PAPER_TOLERANCE && Math.abs(ph - h) <= PAPER_TOLERANCE) || (Math.abs(ph - w) <= PAPER_TOLERANCE && Math.abs(pw - h) <= PAPER_TOLERANCE));
    if (!known) issues.push(`Unusual paper size ${inches(w)} × ${inches(h)}: not Letter, Legal or A4 (set_page_setup paperSize).`);
    const margins: Array<[string, number]> = [["top", s.marginTop], ["right", s.marginRight], ["bottom", s.marginBottom], ["left", s.marginLeft]];
    const bad = margins.filter(([, m]) => m < MARGIN_MIN || m > MARGIN_MAX);
    if (bad.length) issues.push(`Margins out of range: ${bad.map(([n, m]) => `${n} ${inches(m)}`).join(", ")} (courts expect 0.5"–2"; set_page_setup margins).`);
    const contentW = w - s.marginLeft - s.marginRight;
    if (invalidGeometry(s) && !invalidGeometry(options.baseline?.section ?? null)) {
      structuralIssue("Invalid page geometry: dimensions and margins must be finite, dimensions positive, margins nonnegative, and the text area positive. Restore valid geometry without changing the user's chosen paper size unnecessarily.");
    }
    if (contentW < CONTENT_MIN) issues.push(`Text area is only ${inches(contentW)} wide: margins leave too little room for body text.`);
    const contentPx = (contentW / TWIPS_PER_INCH) * PX_PER_INCH;
    const wide = blocks.filter((b) => b.type === "table" && typeof b.tableWidthPx === "number" && b.tableWidthPx > contentPx + 8);
    if (wide.length) {
      issues.push(
        `Table${wide.length === 1 ? "" : "s"} wider than the text area in block${wide.length === 1 ? "" : "s"} ${list(wide.map((b) => b.index))} (${Math.round(wide[0]!.tableWidthPx! / PX_PER_INCH * 100) / 100}" vs ${inches(contentW)}): advisory layout observation. Verify the rendered page for actual overflow. Preserve existing or requested widths unless the user's scope authorizes a layout change.`,
      );
    }
    const overIndent = blocks.filter((b) => (b.type === "paragraph" || b.type === "listItem") && (b.indentLeft ?? 0) > contentW * 0.6);
    if (overIndent.length) issues.push(`Paragraph indent exceeds most of the text width in block${overIndent.length === 1 ? "" : "s"} ${list(overIndent.map((b) => b.index))}: reduce indentLeft.`);
  }

  // --- 5. Empty / orphan paragraphs ------------------------------------------------
  const runs: number[][] = [];
  let cur: number[] = [];
  for (const b of blocks) {
    if (isBlank(b)) cur.push(b.index);
    else {
      if (cur.length) runs.push(cur);
      cur = [];
    }
  }
  if (cur.length) runs.push(cur);
  const doubles = runs.filter((r) => r.length >= 2);
  if (doubles.length) {
    issues.push(
      `${doubles.length} run${doubles.length === 1 ? "" : "s"} of consecutive empty paragraphs (blocks ${doubles.map((r) => `${r[0]}–${r[r.length - 1]}`).slice(0, 4).join(", ")}): advisory spacing observation. Preserve intentional spacing unless cleanup is requested.`,
    );
  }
  if (blocks.length && isBlank(blocks[0]!) && blocks.length > 1) issues.push("The document starts with an empty paragraph (block 0): advisory observation; preserve it unless spacing cleanup is requested.");
  const last = runs[runs.length - 1];
  if (last && last[last.length - 1] === blocks[blocks.length - 1]?.index && !doubles.includes(last)) issues.push(`Trailing empty paragraph at block ${last[0]}: advisory observation; preserve it unless spacing cleanup is requested.`);

  const orphanHeadings: number[] = [];
  blocks.forEach((b, i) => {
    if (b.type !== "heading" || !b.text.trim()) return;
    const next = blocks.slice(i + 1).find((n) => !isBlank(n));
    if (!next) orphanHeadings.push(b.index);
    else if (next.type === "heading" && (next.level ?? 1) <= (b.level ?? 1)) orphanHeadings.push(b.index);
  });
  if (orphanHeadings.length) issues.push(`Heading${orphanHeadings.length === 1 ? "" : "s"} with no body text beneath in block${orphanHeadings.length === 1 ? "" : "s"} ${list(orphanHeadings)}: advisory observation. Bare titles and outline headings can be intentional; do not add descriptors, create body text or remove headings unless requested.`);

  // --- 6. Alignment consistency ------------------------------------------------------
  const body = blocks.filter((b) => b.type === "paragraph" && b.text.trim().length > 120);
  if (body.length >= 4) {
    const counts = new Map<string, number[]>();
    for (const b of body) {
      const a = b.align ?? "left";
      counts.set(a, [...(counts.get(a) ?? []), b.index]);
    }
    const [dominant] = [...counts.entries()].sort((x, y) => y[1].length - x[1].length)[0]!;
    for (const [a, bs] of counts) {
      if (a === dominant) continue;
      if ((a === "center" || a === "right") && bs.length <= Math.max(2, body.length * 0.2)) {
        issues.push(`Inconsistent alignment: ${bs.length} long body paragraph${bs.length === 1 ? "" : "s"} ${a}-aligned (block${bs.length === 1 ? "" : "s"} ${list(bs)}) while the rest are ${dominant === "both" ? "justified" : dominant}: align body text consistently (apply_commands updateParagraphStyle align).`);
      }
    }
  }
  const headingAligns = new Map<number, Map<string, number[]>>();
  for (const b of blocks) {
    if (b.type !== "heading" || !b.text.trim()) continue;
    const lvl = b.level ?? 1;
    const m = headingAligns.get(lvl) ?? new Map<string, number[]>();
    const a = b.align ?? "left";
    m.set(a, [...(m.get(a) ?? []), b.index]);
    headingAligns.set(lvl, m);
  }
  for (const [lvl, m] of headingAligns) {
    if (m.size > 1) {
      const minority = [...m.entries()].sort((x, y) => x[1].length - y[1].length)[0]!;
      issues.push(`Level-${lvl} headings are not aligned alike: ${minority[1].length} ${minority[0]}-aligned (block${minority[1].length === 1 ? "" : "s"} ${list(minority[1])}) vs the others; pick one alignment per heading level.`);
    }
  }

  return (options.structuralOnly ? structural : issues).slice(0, DOC_AUDIT_MAX_ISSUES);
}

/** Trailing text for a tool result or the verify step; empty issues = pass. */
export function formatDocAudit(issues: string[], opts?: { fixInstruction?: boolean; structuralOnly?: boolean }): string {
  if (!issues.length) return `\n<document-audit>✅ Passed: no ${opts?.structuralOnly ? "structural " : ""}findings in the checked document model. This does not verify factual accuracy or all user requirements.</document-audit>`;
  const body = issues.map((s) => `- ${s}`).join("\n");
  const tail =
    opts?.fixInstruction === false
      ? ""
      : opts?.structuralOnly
        ? "\n→ Correct these structural defects within the user's scope. Preserve content, requested colors, theme, heading levels and layout choices. If safe repair requires missing facts, report the limitation instead of inventing content."
        : "\n→ Review these observations against the user's request. Style findings are advisory: do not override requested colors, themes, headings, margins, spacing or intentional formatting to satisfy a default. Repair actual structural defects only within the authorized scope.";
  return `\n<document-audit>⚠️ ${issues.length} finding${issues.length === 1 ? "" : "s"}:\n${body}${tail}\n</document-audit>`;
}
