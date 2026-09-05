// ============================================================================
// Stage 1 — SCAN. Pure, local, no model calls.
//
// Builds a page map before a single token is spent: density, detected heading,
// which risk terms appear, whether the page carries numbers. The map is what
// the router reads (instead of the full text), and it seeds the default
// priority tier for every section so the pipeline degrades gracefully when the
// router call fails.
// ============================================================================
import { RISK_LEXICON } from "@/lib/summarizer-config";

export type PageText = { page: number; text: string };

export type PageMeta = {
  page: number;
  chars: number;
  heading: string | null;
  firstLine: string;
  terms: string[];
  numbers: boolean;
  thin: boolean;
};

export type Tier = "critical" | "normal" | "skim";

export type SectionSignals = {
  index: number;
  from: number;
  to: number;
  heading: string | null;
  terms: string[];
  score: number;
  tier: Tier;
};

const HEADING_RE =
  /^(?:[IVXLC]+\.\s|\d+(?:\.\d+)*\s|ARTICLE\b|SECTION\b|COUNT\b|ORDER\b|[A-Z][A-Z \u2019'\-]{6,}$)/;

const NUMBER_RE = /\$\s?[\d,]+(?:\.\d+)?|\b\d{1,3}(?:,\d{3})+\b|\b(?:19|20)\d{2}\b/;

const BOILERPLATE_RE =
  /certificate of service|proof of service|exhibit cover|this page intentionally|table of authorities/i;

export function scanPages(pages: PageText[]): PageMeta[] {
  return pages.map((p) => {
    const raw = (p.text ?? "").trim();
    const firstLine = raw.split("\n", 1)[0]?.trim() ?? "";
    const lower = raw.toLowerCase();
    const terms = RISK_LEXICON.filter((t) => lower.includes(t));
    return {
      page: p.page,
      chars: raw.length,
      heading: HEADING_RE.test(firstLine) ? firstLine.slice(0, 120) : null,
      firstLine: firstLine.slice(0, 120),
      terms,
      numbers: NUMBER_RE.test(raw),
      thin: raw.length < 300 || BOILERPLATE_RE.test(raw),
    };
  });
}

/**
 * Default priority per section from local signals only. The router refines
 * these; if the router call fails these stand on their own.
 */
export function scoreSections(
  sections: { index: number; from: number; to: number }[],
  meta: PageMeta[],
): SectionSignals[] {
  const byPage = new Map(meta.map((m) => [m.page, m]));
  const raw = sections.map((s) => {
    const pages: PageMeta[] = [];
    for (let p = s.from; p <= s.to; p++) {
      const m = byPage.get(p);
      if (m) pages.push(m);
    }
    const terms = [...new Set(pages.flatMap((p) => p.terms))];
    const density = pages.length ? pages.reduce((n, p) => n + p.chars, 0) / pages.length : 0;
    const thinShare = pages.length ? pages.filter((p) => p.thin).length / pages.length : 1;
    const heading = pages.find((p) => p.heading)?.heading ?? null;
    let score = terms.length * 2;
    if (pages.some((p) => p.numbers)) score += 2;
    if (density > 1_500) score += 1;
    if (thinShare > 0.7) score -= 4;
    return { index: s.index, from: s.from, to: s.to, heading, terms, score, thinShare };
  });

  const scores = raw.map((r) => r.score).sort((a, b) => b - a);
  const cut = scores[Math.floor(scores.length * 0.35)] ?? 0;

  return raw.map((r) => ({
    index: r.index,
    from: r.from,
    to: r.to,
    heading: r.heading,
    terms: r.terms,
    score: r.score,
    tier: (r.thinShare > 0.7 && r.score <= 0
      ? "skim"
      : r.score >= Math.max(cut, 4)
        ? "critical"
        : "normal") as Tier,
  }));
}

/** Compact map handed to the router — headings and signals, never full text. */
export function renderPageMap(sections: SectionSignals[], meta: PageMeta[]): string {
  const byPage = new Map(meta.map((m) => [m.page, m]));
  return sections
    .map((s) => {
      const heads: string[] = [];
      for (let p = s.from; p <= s.to && heads.length < 6; p++) {
        const m = byPage.get(p);
        if (m?.heading) heads.push(`p.${p} ${m.heading}`);
      }
      if (!heads.length) {
        const m = byPage.get(s.from);
        if (m?.firstLine) heads.push(`p.${s.from} ${m.firstLine}`);
      }
      const terms = s.terms.slice(0, 10).join(", ");
      return `S${s.index} pp.${s.from}-${s.to} | ${heads.join(" · ") || "(no heading)"}${
        terms ? ` | terms: ${terms}` : ""
      }`;
    })
    .join("\n");
}
