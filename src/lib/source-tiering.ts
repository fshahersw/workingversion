/**
 * Source tiering + freshness (research quality item 8).
 *
 * Ranks retrieved authorities so primary sources outrank trade press, and
 * marks anything stale enough that a litigator should re-confirm it.
 */
import type { Source } from "./chat-types";

export type Tier = 1 | 2 | 3;

export type SourceGrade = {
  tier: Tier;
  tierLabel: string;
  tierHint: string;
  ageDays: number | null;
  stale: boolean;
};

const TIER1 =
  /(pacer|docket|court|opinion|slip op|f\.?\s?supp|f\.?\d?d\b|u\.?s\.?c\.?|c\.?f\.?r\.?|federal register|statute|regulation|precedent|jpml|mdl no|cmo|pretrial order)/i;
const TIER2 =
  /(fda|cpsc|epa|nhtsa|osha|cdc|nih|pubmed|guidance|advisory|maude|recall|warning letter|peer|journal|study|agency)/i;
const TIER3 =
  /(law360|reuters|bloomberg|news|blog|press|wsj|nyt|legal ?news|reporting|article|web)/i;

const TIER_META: Record<Tier, { label: string; hint: string }> = {
  1: { label: "Primary", hint: "Court record, statute, or regulation" },
  2: { label: "Official", hint: "Agency record or peer-reviewed science" },
  3: { label: "Reported", hint: "Trade press — treat as signal, not authority" },
};

/** Max age before a source is flagged for re-confirmation, by tier. */
const STALE_DAYS: Record<Tier, number> = { 1: 365, 2: 1095, 3: 180 };

function detectTier(s: Source): Tier {
  const hay = `${s.authority ?? ""} ${s.source_type ?? ""} ${s.citation ?? ""} ${s.source_url ?? ""}`;
  if (TIER1.test(hay)) return 1;
  if (TIER2.test(hay)) return 2;
  if (TIER3.test(hay)) return 3;
  return 2;
}

function ageInDays(date?: string): number | null {
  if (!date) return null;
  const t = Date.parse(date);
  if (Number.isNaN(t)) return null;
  return Math.max(0, Math.round((Date.now() - t) / 86_400_000));
}

export function gradeSource(s: Source): SourceGrade {
  const tier = detectTier(s);
  const ageDays = ageInDays(s.effective_date);
  const stale =
    s.is_current === false ||
    (ageDays !== null && ageDays > STALE_DAYS[tier]);
  return {
    tier,
    tierLabel: TIER_META[tier].label,
    tierHint: TIER_META[tier].hint,
    ageDays,
    stale,
  };
}

/** Primary authority first, then by original ref order. */
export function sortByAuthority(sources: Source[]): Source[] {
  return [...sources].sort((a, b) => {
    const ta = gradeSource(a).tier;
    const tb = gradeSource(b).tier;
    if (ta !== tb) return ta - tb;
    return (
      (parseInt(a.ref.slice(1), 10) || 0) - (parseInt(b.ref.slice(1), 10) || 0)
    );
  });
}
