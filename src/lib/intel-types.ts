// Shared types for the litigation intelligence terminal (client-safe).

export type IntelPrimarySource = {
  title: string;
  url: string;
  domain: string | null;
  summary: string | null;
};

export type IntelItem = {
  id: string;
  category: string;
  title: string;
  url: string;
  summary: string | null;
  sourceDomain: string | null;
  sourceName: string | null;
  faviconUrl: string | null;
  imageUrl: string | null;
  imageKind: string | null;
  imageAlt: string | null;
  signalScore: number;
  paywall: string | null;
  rights: string | null;
  publishedAt: string | null;
  fetchedAt: string | null;
  relatedTopics: string[];
  matterSlug: string | null;
  matterLabel: string | null;
  primarySources: IntelPrimarySource[];
  /** Cached AI briefing generated during the backend run. */
  analysisLead: string | null;
  bullets: string[];
  impact: string | null;
};

export type IntelFeedPage = { items: IntelItem[] };

export type IntelStatus = {
  lastRunAt: string | null;
  itemCount: number;
  errorCount: number;
  byCategory: Record<string, number>;
  healthy: boolean;
};

export type CorpusSignal = {
  id: string;
  kind: "matter" | "filing" | "alert";
  title: string;
  detail: string;
  badge: string | null;
  timestamp: string | null;
  matterSlug: string | null;
  matterLabel: string | null;
  meta: string[];
  /** Cached plain-language briefing for docket entries. */
  bullets: string[];
  impact: string | null;
};


/** Tab identity for the terminal. `origin` decides which reader serves it. */
export type SectionId =
  | "news"
  | "mdl"
  | "filings"
  | "courts"
  | "agencies"
  | "research"
  | "settlements"
  | "commentary"
  | "alerts";

export const SECTIONS: { id: SectionId; label: string; origin: "intel" | "corpus" }[] = [
  { id: "news", label: "News & Analysis", origin: "intel" },
  { id: "mdl", label: "MDL / Mass Tort", origin: "corpus" },
  { id: "filings", label: "Filings & Orders", origin: "corpus" },
  { id: "courts", label: "Courts & Appeals", origin: "intel" },
  { id: "agencies", label: "Agencies", origin: "intel" },
  { id: "research", label: "Research", origin: "intel" },
  { id: "settlements", label: "Settlements", origin: "intel" },
  { id: "commentary", label: "Commentary", origin: "intel" },
  { id: "alerts", label: "Alerts", origin: "corpus" },
];
