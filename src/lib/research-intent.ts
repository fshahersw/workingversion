/**
 * Lightweight intent classification for litigation research queries.
 *
 * Runs client-side (no extra latency) and produces retrieval hints that are
 * merged into every orchestrate / quick-ask request body. Backends that ignore
 * the extra fields are unaffected.
 */

export type ResearchIntent =
  | "docket"
  | "causation_science"
  | "regulatory"
  | "case_law"
  | "settlement"
  | "class_cert"
  | "intake_strategy"
  | "general";

export type RetrievalHints = {
  intent: ResearchIntent;
  preferred_sources: string[];
  recency_days: number;
  focus_note: string;
};

const RULES: {
  intent: ResearchIntent;
  re: RegExp;
  sources: string[];
  recency: number;
  note: string;
}[] = [
  {
    intent: "docket",
    re: /\b(mdl|jpml|docket|cmo\b|pto\b|bellwether|transferee|case management|pacer|scheduling order|remand)\b/i,
    sources: ["pacer", "jpml", "court_dockets", "law360"],
    recency: 180,
    note: "Prioritize the live docket: MDL number, transferee judge, most recent CMO/PTO, and current bellwether schedule.",
  },
  {
    intent: "causation_science",
    re: /\b(causation|epidemiolog|study|studies|meta-analysis|daubert|rule 702|expert|biological plausibility|dose[- ]response|cohort)\b/i,
    sources: ["pubmed", "peer_reviewed", "court_opinions", "fda"],
    recency: 1825,
    note: "Prioritize peer-reviewed epidemiology and toxicology plus Rule 702/Daubert rulings addressing the same experts or methods.",
  },
  {
    intent: "regulatory",
    re: /\b(fda|recall|warning letter|maude|label(ing)?|cpsc|epa|advisory committee|510\(k\)|pma|nhtsa)\b/i,
    sources: ["fda", "cpsc", "epa", "federal_register", "nhtsa"],
    recency: 730,
    note: "Prioritize primary agency records: recall notices, warning letters, MAUDE reports, labeling changes, with exact dates.",
  },
  {
    intent: "class_cert",
    re: /\b(rule 23|class cert|certification|predominance|ascertainab|commonality|typicality)\b/i,
    sources: ["court_opinions", "westlaw", "law360"],
    recency: 1095,
    note: "Prioritize recent Rule 23 certification and decertification opinions, with circuit-level splits identified.",
  },
  {
    intent: "settlement",
    re: /\b(settle|settlement|common benefit|lien|allocation|special master|matrix|qsf)\b/i,
    sources: ["court_dockets", "settlement_agreements", "law360", "reuters_legal"],
    recency: 1095,
    note: "Prioritize the operative settlement agreement, allocation matrix, and common benefit orders; flag figures that need docket confirmation.",
  },
  {
    intent: "intake_strategy",
    re: /\b(intake|screening|criteria|fact sheet|pfs\b|checklist|workup|case evaluation|statute of (limitations|repose))\b/i,
    sources: ["court_dockets", "statutes", "practice_guides"],
    recency: 1095,
    note: "Produce operational criteria a plaintiffs' intake team can apply, including jurisdiction-specific limitations/repose deadlines.",
  },
  {
    intent: "case_law",
    re: /\b(preemption|mensing|bartlett|riegel|albrecht|holding|circuit|opinion|ruling|affirmed|reversed|summary judgment)\b/i,
    sources: ["court_opinions", "westlaw", "court_dockets"],
    recency: 1825,
    note: "Prioritize controlling authority; separate binding from persuasive holdings and note pending appeals.",
  },
];

const BASE_SOURCES = ["court_dockets", "court_opinions", "fda", "peer_reviewed"];

export function classifyIntent(query: string): RetrievalHints {
  const hit = RULES.find((r) => r.re.test(query));
  if (!hit) {
    return {
      intent: "general",
      preferred_sources: BASE_SOURCES,
      recency_days: 730,
      focus_note:
        "Prioritize primary sources over trade press; state the procedural posture and date of every authority relied on.",
    };
  }
  return {
    intent: hit.intent,
    preferred_sources: hit.sources,
    recency_days: hit.recency,
    focus_note: hit.note,
  };
}
