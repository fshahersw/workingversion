// ============================================================================
// §12 Authority ranking + source de-duplication (pure, browser-safe, tested).
//
// Encodes the source hierarchy in software so authority judgments are
// deterministic rather than left to the model:
//
//   LEVEL 1  official primary   (court filing/opinion, statute, regulation,
//                                official agency/government source)
//   LEVEL 2  trusted primary repository (CourtListener/RECAP, GovInfo,
//                                ClinicalTrials.gov, SEC structured API)
//   LEVEL 3  first-party / professional reporting (issuer filing, major wire)
//   LEVEL 4  commentary / secondary analysis (firm alert, academic, treatise)
//   LEVEL 5  general web / unverified aggregation / social
//
// Rules (§12):
//   - A lower level always wins: a Level-1 contradiction beats a Level-4
//     statement, and a newer source does NOT automatically beat controlling
//     authority. Recency only breaks ties WITHIN the same level.
//   - Publication date and event date are distinct fields (§50).
//   - Secondary sources are discovery aids, not substitutes for primary law.
// ============================================================================
import type { AuthorityLevel, EvidenceItem, SourceType } from "./frontier-contracts.ts";
import { normalizeUrl } from "./web-rank.ts";

/** Canonical authority level for a source type. Tool wrappers use this to STAMP
 *  EvidenceItem.authorityLevel at normalization time so ranking downstream is a
 *  simple field comparison. */
const LEVEL_BY_SOURCE: Record<SourceType, AuthorityLevel> = {
  court_filing: 1,
  court_opinion: 1,
  statute: 1,
  regulation: 1,
  agency: 1,
  government: 1,
  clinical_trial: 2,
  sec_filing: 3,
  news: 3,
  secondary: 4,
  web: 5,
};

export function authorityLevelForSource(sourceType: SourceType): AuthorityLevel {
  return LEVEL_BY_SOURCE[sourceType];
}

/** Levels 1-2 are primary material (official sources + trusted primary
 *  repositories); 3-5 are reporting/commentary/web. */
export function isPrimarySource(level: AuthorityLevel): boolean {
  return level <= 2;
}

/** Best date to compare within a level: the underlying event/effective date if
 *  known, else the publication/filing date. Both are ISO strings, which sort
 *  lexicographically, so a plain string compare is a chronological compare. */
function bestDate(item: EvidenceItem): string | undefined {
  return item.eventDate ?? item.publishedAt;
}

/**
 * Order two evidence items by authority. Negative => `a` outranks `b` (sorts
 * first); positive => `b` outranks `a`; 0 => equal standing.
 *
 * Authority dominates recency: the lower authorityLevel always wins. Only when
 * levels are equal do we prefer a currently-verified source, then the more
 * recent one.
 */
export function compareAuthority(a: EvidenceItem, b: EvidenceItem): number {
  if (a.authorityLevel !== b.authorityLevel) return a.authorityLevel - b.authorityLevel;
  if (a.currentVerified !== b.currentVerified) return a.currentVerified ? -1 : 1;
  const da = bestDate(a);
  const db = bestDate(b);
  if (da && db && da !== db) return da > db ? -1 : 1;
  if (da && !db) return -1;
  if (!da && db) return 1;
  return 0;
}

/** True when `a` is a strictly stronger authority than `b`. */
export function outranks(a: EvidenceItem, b: EvidenceItem): boolean {
  return compareAuthority(a, b) < 0;
}

/** Stable ranking, strongest authority first. Does not mutate the input. */
export function rankEvidence(items: readonly EvidenceItem[]): EvidenceItem[] {
  return [...items].sort(compareAuthority);
}

/** Identity key for de-duplication: prefer a content hash, else the normalized
 *  URL, else the item id. Two retrievals of the same document collapse to one. */
export function evidenceKey(item: EvidenceItem): string {
  if (item.hash && item.hash.trim()) return `hash:${item.hash.trim()}`;
  const url = normalizeUrl(item.url);
  if (url) return `url:${url}`;
  return `id:${item.id}`;
}

function unionStrings(a: readonly string[], b: readonly string[]): string[] {
  return [...new Set([...a, ...b])];
}

/**
 * Collapse duplicate sources (§29 "maximum duplicate-source fetches: 0" applied
 * to already-gathered evidence). When two items share an identity key, keep the
 * higher-authority instance and union the supports/contradicts links so no
 * proposition mapping is lost. Insertion order of first-seen keys is preserved;
 * call rankEvidence() when a ranked order is needed.
 */
export function dedupeEvidence(items: readonly EvidenceItem[]): EvidenceItem[] {
  const byKey = new Map<string, EvidenceItem>();
  for (const item of items) {
    const key = evidenceKey(item);
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, item);
      continue;
    }
    const winner = compareAuthority(existing, item) <= 0 ? existing : item;
    const loser = winner === existing ? item : existing;
    byKey.set(key, {
      ...winner,
      supports: unionStrings(winner.supports, loser.supports),
      contradicts: unionStrings(winner.contradicts, loser.contradicts),
    });
  }
  return [...byKey.values()];
}
