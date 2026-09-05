// Curated static litigation headlines. Replaces the removed Lovable Cloud
// news_headlines table — no network calls, stable across renders.

export type Headline = {
  id: string;
  category: string;
  title: string;
  url: string;
  source_domain: string | null;
  snippet: string | null;
  image_url: string | null;
  published_at: string | null;
  fetched_at: string;
};

const BASE = "2026-08-20T13:00:00.000Z";

const RAW: Omit<Headline, "fetched_at">[] = [
  {
    id: "n1",
    category: "mdl",
    title: "Talc MDL bellwether pool narrowed ahead of spring trial setting",
    url: "https://www.reuters.com/legal/",
    source_domain: "reuters.com",
    snippet:
      "The court trimmed the bellwether pool and set a pretrial conference, signaling the first trials will proceed on the current schedule.",
    image_url: null,
    published_at: "2026-08-19T15:20:00.000Z",
  },
  {
    id: "n2",
    category: "regulatory",
    title: "FDA issues Class I recall for infusion pump software defect",
    url: "https://www.fda.gov/safety/recalls-market-withdrawals-safety-alerts",
    source_domain: "fda.gov",
    snippet:
      "The agency flagged a dosing error risk affecting several device lots, a common precursor to product liability filings.",
    image_url: null,
    published_at: "2026-08-18T18:05:00.000Z",
  },
  {
    id: "n3",
    category: "courts",
    title: "Third Circuit clarifies standard for expert general-causation testimony",
    url: "https://www.ca3.uscourts.gov/",
    source_domain: "uscourts.gov",
    snippet:
      "The panel reaffirmed that methodological reliability, not conclusion strength, governs the Rule 702 gatekeeping inquiry.",
    image_url: null,
    published_at: "2026-08-17T12:40:00.000Z",
  },
  {
    id: "n4",
    category: "settlements",
    title: "Hair relaxer defendants disclose framework for global resolution talks",
    url: "https://www.law360.com/",
    source_domain: "law360.com",
    snippet:
      "Parties reported progress toward a settlement framework covering registered claims, with allocation terms still open.",
    image_url: null,
    published_at: "2026-08-16T20:10:00.000Z",
  },
  {
    id: "n5",
    category: "science",
    title: "New epidemiology study strengthens exposure-response signal in PFAS cohort",
    url: "https://www.nejm.org/",
    source_domain: "nejm.org",
    snippet:
      "Peer-reviewed cohort analysis reports a dose-dependent association, likely to feature in causation briefing.",
    image_url: null,
    published_at: "2026-08-15T09:30:00.000Z",
  },
  {
    id: "n6",
    category: "mdl",
    title: "JPML consolidates new device actions into a single district",
    url: "https://www.jpml.uscourts.gov/",
    source_domain: "uscourts.gov",
    snippet:
      "The panel found common questions of fact predominate and centralized pending actions for coordinated pretrial proceedings.",
    image_url: null,
    published_at: "2026-08-14T16:00:00.000Z",
  },
  {
    id: "n7",
    category: "regulatory",
    title: "Warning letter cites manufacturing deviations at contract facility",
    url: "https://www.fda.gov/inspections-compliance-enforcement-and-criminal-investigations/compliance-actions-and-activities/warning-letters",
    source_domain: "fda.gov",
    snippet:
      "Inspectors documented CGMP deviations, creating a documentary record relevant to defect and notice theories.",
    image_url: null,
    published_at: "2026-08-13T14:25:00.000Z",
  },
  {
    id: "n8",
    category: "courts",
    title: "Court enters amended case management order on plaintiff fact sheets",
    url: "https://www.uscourts.gov/",
    source_domain: "uscourts.gov",
    snippet:
      "CMO revises fact sheet deadlines and cure periods, with dismissal exposure for non-compliant claimants.",
    image_url: null,
    published_at: "2026-08-12T11:15:00.000Z",
  },
  {
    id: "n9",
    category: "settlements",
    title: "Special master appointed to oversee claims allocation process",
    url: "https://www.law.com/",
    source_domain: "law.com",
    snippet:
      "The appointment covers claim valuation and lien resolution for the announced resolution program.",
    image_url: null,
    published_at: "2026-08-11T17:45:00.000Z",
  },
  {
    id: "n10",
    category: "science",
    title: "Meta-analysis questions confounding controls in earlier exposure studies",
    url: "https://jamanetwork.com/",
    source_domain: "jamanetwork.com",
    snippet:
      "Authors call for stratified reanalysis, a point defense experts are expected to press at Daubert.",
    image_url: null,
    published_at: "2026-08-10T08:55:00.000Z",
  },
];

export const STATIC_HEADLINES: Headline[] = RAW.map((h) => ({ ...h, fetched_at: BASE }));

export function staticHeadlines(category: string): Headline[] {
  const rows =
    category === "all" ? STATIC_HEADLINES : STATIC_HEADLINES.filter((h) => h.category === category);
  return rows.slice(0, category === "all" ? 30 : 12);
}
