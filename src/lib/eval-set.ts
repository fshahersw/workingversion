/**
 * Gold-standard litigation evaluation set (research quality item 11).
 *
 * Each case is a question a Seeger Weiss attorney would realistically ask,
 * paired with cheap, deterministic expectations the harness can score without
 * a human grader: terms the answer should surface, authorities the retrieval
 * should reach, and the minimum source tier the answer must rest on.
 */

export type EvalCase = {
  id: string;
  question: string;
  category:
    | "docket"
    | "causation"
    | "regulatory"
    | "settlement"
    | "procedure"
    | "discovery"
    // Deep = deliberately multi-entity / cross-domain questions that a single
    // pass tends to under-serve. These are the stressors for the triggered
    // multi-agent path: the bar it must beat without regressing latency.
    | "deep";
  /** Lowercase substrings the answer is expected to mention (recall proxy). */
  expectTerms: string[];
  /** Lowercase substrings expected somewhere in retrieved source metadata. */
  expectAuthorities: string[];
  /** Best tier the source set must include (1 = primary record). */
  requireTier: 1 | 2 | 3;
};

export const EVAL_SET: EvalCase[] = [
  {
    id: "camp-lejeune-status",
    question:
      "What is the current status of the Camp Lejeune Justice Act litigation, including any recent case management orders and trial plans?",
    category: "docket",
    expectTerms: ["camp lejeune", "eastern district of north carolina", "track"],
    expectAuthorities: ["court", "order", "docket"],
    requireTier: 1,
  },
  {
    id: "talc-mdl-2738",
    question:
      "Summarize the procedural posture of In re Johnson & Johnson Talcum Powder MDL 2738 and the status of any bankruptcy-related stay.",
    category: "procedure",
    expectTerms: ["mdl 2738", "talc", "stay"],
    expectAuthorities: ["court", "mdl", "opinion"],
    requireTier: 1,
  },
  {
    id: "roundup-daubert",
    question:
      "How have federal courts treated general causation expert testimony on glyphosate and non-Hodgkin lymphoma under Rule 702?",
    category: "causation",
    expectTerms: ["rule 702", "general causation", "non-hodgkin"],
    expectAuthorities: ["court", "opinion", "iarc"],
    requireTier: 1,
  },
  {
    id: "hair-relaxer-science",
    question:
      "What is the strongest epidemiological support for uterine cancer claims in the hair relaxer litigation?",
    category: "causation",
    expectTerms: ["uterine", "sister study", "relative risk"],
    expectAuthorities: ["nih", "study", "journal"],
    requireTier: 2,
  },
  {
    id: "fda-recall-process",
    question:
      "What FDA recall classifications and warning letters matter most when building a device defect claim, and how are they proven up?",
    category: "regulatory",
    expectTerms: ["class i", "warning letter", "510(k)"],
    expectAuthorities: ["fda", "guidance", "recall"],
    requireTier: 2,
  },
  {
    id: "afff-settlement",
    question:
      "Summarize the AFFF water-provider settlements, including amounts, participating defendants, and claim deadlines.",
    category: "settlement",
    expectTerms: ["afff", "pfas", "settlement"],
    expectAuthorities: ["court", "order", "district of south carolina"],
    requireTier: 1,
  },
  {
    id: "census-plus-discovery",
    question:
      "What are the standard plaintiff fact sheet and census obligations in a recently formed MDL, and what are the consequences of non-compliance?",
    category: "discovery",
    expectTerms: ["plaintiff fact sheet", "show cause", "dismissal"],
    expectAuthorities: ["order", "court", "cmo"],
    requireTier: 1,
  },
  {
    id: "lone-pine",
    question:
      "When do courts enter Lone Pine orders in mass tort MDLs and how should plaintiffs' leadership respond?",
    category: "procedure",
    expectTerms: ["lone pine", "prima facie", "case management"],
    expectAuthorities: ["court", "order", "opinion"],
    requireTier: 1,
  },

  // --- Deep, multi-entity / cross-domain stressors --------------------------
  // Each spans several parties, jurisdictions, or evidence domains, so a single
  // linear pass has to juggle independent sub-questions. Expectations stay
  // deterministic (term + authority substrings), so the harness can score them
  // for both the single-agent baseline and the flagged multi-agent path.
  {
    id: "deep-daubert-cross-mdl",
    question:
      "Compare how federal courts have applied Rule 702 to general-causation expert testimony across the Roundup glyphosate / non-Hodgkin lymphoma, Johnson & Johnson talc MDL 2738, and hair relaxer uterine-cancer litigations, and identify where the rulings diverge.",
    category: "deep",
    expectTerms: ["rule 702", "general causation", "glyphosate", "talc", "hair relaxer"],
    expectAuthorities: ["court", "opinion", "mdl"],
    requireTier: 1,
  },
  {
    id: "deep-afff-settlement-posture",
    question:
      "For the AFFF PFAS MDL in the District of South Carolina, cross-reference the water-provider settlement terms and claim deadlines with the current bellwether trial schedule and the controlling rulings on the government-contractor defense.",
    category: "deep",
    expectTerms: ["afff", "pfas", "settlement", "bellwether", "government contractor"],
    expectAuthorities: ["court", "order", "district of south carolina"],
    requireTier: 1,
  },
  {
    id: "deep-hair-relaxer-reg-science-docket",
    question:
      "In the hair relaxer MDL, connect the FDA's proposed ban on formaldehyde-releasing chemical hair straighteners to the epidemiological evidence on uterine cancer and the current procedural posture in the Northern District of Illinois.",
    category: "deep",
    expectTerms: ["hair relaxer", "formaldehyde", "uterine", "northern district of illinois"],
    expectAuthorities: ["fda", "court", "study"],
    requireTier: 1,
  },
];
