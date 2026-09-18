import type { SectionSettings } from "@genoffice/docx-engine";

/**
 * Semantic page-setup change for the Writer's set_page_setup / apply_court_style
 * tools. Fields are applied per section so that, with "all sections", a
 * landscape exhibit section keeps its own paper size when only the margins
 * change, and a legal-size section stays legal when the orientation flips.
 * `paper` gives PORTRAIT dimensions in twips; each section orients them.
 */
export type PageSetupPatch = {
  orientation?: "portrait" | "landscape";
  paper?: { w: number; h: number };
  margins?: Partial<
    Pick<SectionSettings, "marginTop" | "marginRight" | "marginBottom" | "marginLeft">
  >;
  columns?: number;
  colSpace?: number;
};

export const TWIPS_PER_INCH = 1440;
export const TWIPS_PER_POINT = 20;

/** Portrait paper sizes in twips (Word's Page Setup values). */
export const PAPER_TWIPS: Record<string, { w: number; h: number }> = {
  letter: { w: 12240, h: 15840 },
  legal: { w: 12240, h: 20160 },
  a4: { w: 11906, h: 16838 },
};

/** Apply a PageSetupPatch to one section's settings (pure). */
export function applyPageSetupPatch(s: SectionSettings, patch: PageSetupPatch): SectionSettings {
  let next: SectionSettings = { ...s };
  if (patch.paper) {
    const landscape = next.orientation === "landscape";
    next = {
      ...next,
      pageWidth: landscape ? patch.paper.h : patch.paper.w,
      pageHeight: landscape ? patch.paper.w : patch.paper.h,
    };
  }
  if (patch.orientation && patch.orientation !== next.orientation) {
    next = {
      ...next,
      orientation: patch.orientation,
      pageWidth: next.pageHeight,
      pageHeight: next.pageWidth,
    };
  }
  if (patch.margins) next = { ...next, ...patch.margins };
  if (patch.columns !== undefined) {
    next = {
      ...next,
      columns: patch.columns,
      ...(patch.columns > 1 && !next.colSpace ? { colSpace: patch.colSpace ?? 720 } : {}),
    };
  }
  return next;
}

export function twipsToInches(twips: number): string {
  return (Math.round((twips / TWIPS_PER_INCH) * 100) / 100).toString();
}
