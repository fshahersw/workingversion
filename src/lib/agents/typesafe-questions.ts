// ============================================================================
// Every TypeSafe question and threshold this app asks, in one file (pure).
//
// Reviewers should read THIS file, not the call sites: the questions decide
// what Jev is asked, the thresholds decide what code does with the answer.
// Design rules (docs.typesafe.ai/model-jaggedness/jev-1.13):
//   - Jev reads literally: each criterion says what it covers, what it does
//     NOT cover, and gives examples; instructions state the tie-break rule.
//   - State is a small named object; questions point at fields by backticked
//     path. Only what the decision needs is sent (context rot).
//   - Speculative fan-out: every question a decision might need goes in ONE
//     request; code reads the relevant answers.
//   - Thresholds scale with risk. Routing DOWN to a cheaper model or a thinner
//     budget is the risky direction, so it needs confidence; routing UP is the
//     safe default and needs none.
//   - Nouls are absolute, Choices are relative; never carry a threshold across.
// Decision functions take the API result and return a typed decision or null
// ("no opinion"), so callers fall back to their existing path.
// ============================================================================
import type { EffortMode } from "@/lib/research-intent";

import { choice, noul, choiceAnswer, noulAnswer, type Question, type SystemOneResult } from "./typesafe.server";

// --- Thresholds (all of them) ------------------------------------------------------

export const THRESHOLDS = {
  /** Office: Choice confidence needed to route to a cheaper tier than main. */
  officeRouteMinConfidence: 0.55,
  /** Office: probability mass on draft+analyze above which the turn stays on main. */
  officeHeavyMassMax: 0.35,
  /** Office: "needs legal judgment" noul at or above this forces the main tier. */
  officeLegalJudgmentMin: 0.6,
  /** Research: Choice confidence needed to short-circuit as conversational. */
  researchConversationalMinConfidence: 0.8,
  /** Research: a conversational verdict is vetoed when the legal-subject noul is above this. */
  researchLegalSubjectMax: 0.3,
  /** Research: Choice confidence needed to take the tighter FAST budget. */
  researchFastMinConfidence: 0.6,
  /** Research: a deliverable request never runs on the FAST budget above this. */
  researchDeliverableMin: 0.5,
  /** Memory: topic-shift noul at or above this clears the session ledger. */
  topicShiftYes: 0.7,
  /** Memory: topic-shift noul at or below this keeps the ledger; between = uncertain (fall back). */
  topicShiftNo: 0.35,
} as const;

// --- Office task class ------------------------------------------------------------
//
// Mirrors the five classes of inference.server.ts ROUTER_SYSTEM so the rest of
// routeTurn (inspect tier, vision check, cache) is unchanged.

export type OfficeTaskClass = "inspect" | "format" | "short_edit" | "draft" | "analyze";
export type OfficeApp = "writer" | "sheets" | "slides";

const EDITOR_LABEL: Record<OfficeApp, string> = {
  writer: "a Word-like document editor",
  sheets: "a spreadsheet editor",
  slides: "a slide deck editor",
};

export function officeRouteState(app: OfficeApp, instruction: string): Record<string, unknown> {
  return {
    editor: EDITOR_LABEL[app],
    request: { text: instruction.slice(0, 3_000) },
  };
}

export function officeRouteQuestions(): Record<string, Question> {
  return {
    task_class: choice(
      {
        question: "What kind of work does `request.text` ask the assistant for `editor` to do?",
        tie_break:
          "If the request mixes kinds, pick the heaviest one present: analyze > draft > short_edit > format > inspect.",
      },
      {
        inspect: {
          what: "Read, find, explain, summarize, count, compare, list, check or audit what is already in the document, or answer a question about it, WITHOUT changing anything",
          not_for: "Any request that changes content or appearance",
          examples: ["What does section 3 say?", "How many footnotes are there?", "Check the citations in this brief", "Summarize this deck"],
        },
        format: {
          what: "Change appearance or layout only: fonts, sizes, spacing, alignment, styles, heading levels, numbering, column widths, colors, borders, table styling, page setup, slide layout tidy-ups, consistency fixes",
          not_for: "Changing the words, numbers or data",
          examples: ["Make all headings Times New Roman 14pt", "Double-space the body", "Repeat the header row on every page", "Align these boxes"],
        },
        short_edit: {
          what: "One small, fully specified content change: fix a typo or one sentence, rename something, change one number or date, add or remove one item, tweak one paragraph, fill one cell or formula, swap one image, delete one slide",
          not_for: "New sections, several paragraphs of new text, or changes across the whole document",
          examples: ["Change the hearing date to March 3", "Fix the typo in the second paragraph", "Add a row for Q4", "Delete slide 7"],
        },
        draft: {
          what: "Write or generate substantive new content: a section, memo, letter, summary, several slides or a whole deck, a table of new data, a chart from analysis; restructure the document or rewrite it for tone throughout",
          not_for: "Requests whose difficulty is legal or analytical judgment about the substance rather than writing",
          examples: ["Draft a two-page memo on the motion", "Build a 10-slide deck from these notes", "Rewrite the whole letter in a formal tone"],
        },
        analyze: {
          what: "Work that needs careful judgment or multi-step reasoning: legal analysis, argument review, reconciling conflicting sources, complex data analysis or modelling, risk assessment, research across sources",
          not_for: "Plain writing, formatting or lookups",
          examples: ["Assess the weaknesses in our preemption argument", "Reconcile these two damages models", "Which of these cases still supports our position?"],
        },
      },
    ),
    changes_document: noul("Does `request.text` ask for any change to the document's content or appearance?"),
    needs_legal_judgment: noul(
      "Does carrying out `request.text` require legal analysis or judgment about the substance of the document, rather than reading, editing, or formatting it?",
    ),
  };
}

export type OfficeRouteDecision = {
  taskClass: OfficeTaskClass;
  confidence: number;
  /** why this class (for logs) */
  reason: string;
};

const OFFICE_CLASSES = new Set<OfficeTaskClass>(["inspect", "format", "short_edit", "draft", "analyze"]);

/**
 * Turn the answers into a task class, or null when Jev has no usable opinion.
 * Down-routes (anything but draft/analyze) need confidence; the heavy classes
 * are accepted at any confidence because they map to the main tier anyway.
 */
export function decideOfficeClass(res: SystemOneResult | null): OfficeRouteDecision | null {
  const a = choiceAnswer(res, "task_class");
  if (!a || !OFFICE_CLASSES.has(a.choice as OfficeTaskClass)) return null;
  const cls = a.choice as OfficeTaskClass;
  const heavyMass = (a.probabilities["draft"] ?? 0) + (a.probabilities["analyze"] ?? 0);
  const legal = noulAnswer(res, "needs_legal_judgment") ?? 0;
  if (legal >= THRESHOLDS.officeLegalJudgmentMin) {
    return { taskClass: "analyze", confidence: a.confidence, reason: `legal judgment ${legal.toFixed(2)}` };
  }
  if (cls === "draft" || cls === "analyze") {
    return { taskClass: cls, confidence: a.confidence, reason: "heavy class" };
  }
  if (heavyMass > THRESHOLDS.officeHeavyMassMax) {
    return { taskClass: "draft", confidence: a.confidence, reason: `heavy mass ${heavyMass.toFixed(2)}` };
  }
  if (a.confidence < THRESHOLDS.officeRouteMinConfidence) return null; // unsure: let the caller keep its default (main)
  const changes = noulAnswer(res, "changes_document");
  if (cls === "inspect" && changes !== null && changes >= 0.6) {
    // "read-only" verdict contradicted by the change question: too ambiguous to down-route
    return null;
  }
  return { taskClass: cls, confidence: a.confidence, reason: "choice" };
}

// --- Research effort (conversational / fast / think) ------------------------------

export function researchEffortState(query: string, historyTurns: number): Record<string, unknown> {
  return {
    question: { text: query.slice(0, 3_000) },
    conversation: { prior_turns: historyTurns, has_prior_answer: historyTurns > 0 },
  };
}

export function researchEffortQuestions(): Record<string, Question> {
  return {
    effort: choice(
      {
        question: "How much research work does `question.text` call for from a legal research assistant?",
        tie_break: "If parts of the request fall in different levels, pick the highest level present: think > fast > conversational.",
      },
      {
        conversational: {
          what: "A greeting, thanks, or acknowledgement; a question about the assistant itself; or a request to reformat, shorten, rephrase or re-explain the assistant's PREVIOUS answer (only possible when `conversation.has_prior_answer` is true). No new information is needed.",
          not_for: "Any new question about a case, matter, court, judge, statute, regulation, drug, device, company or legal issue, however short",
          examples: ["thanks", "make that shorter", "put that in a table", "who are you"],
        },
        fast: {
          what: "One scoped lookup with a clear, named target that one or two sources can answer: the status of a named case or MDL, one ruling or order, one deadline or hearing date, one statute or rule, what one document says",
          not_for: "Comparisons, multi-part questions, strategy, comprehensive surveys, or producing a document",
          examples: ["What is the status of MDL 2738?", "When is the next Roundup bellwether trial?", "What does Rule 26(a)(2) require?"],
        },
        think: {
          what: "Multi-part, comparative, strategic or comprehensive work: several questions at once, analysis across sources or jurisdictions, weighing arguments, timelines, or any request for a report, memo, brief, spreadsheet or other deliverable",
          not_for: "A single narrow lookup",
          examples: ["Compare the Daubert rulings in the Zantac and Roundup MDLs", "Give me a comprehensive update on talc litigation with all recent rulings", "Draft a memo on preemption risk"],
        },
      },
    ),
    wants_deliverable: noul(
      "Does `question.text` ask for a file or document deliverable, such as a memo, report, brief, spreadsheet, PDF or Word document, rather than a chat answer?",
    ),
    legal_subject: noul(
      "Is `question.text` about a legal matter, case, court, judge, statute, regulation, litigation over a drug, device or product, or a party to litigation?",
    ),
    needs_current_info: noul(
      "Does answering `question.text` depend on recent developments, such as the latest status, new filings, recent rulings or current news, rather than settled background?",
    ),
  };
}

export type ResearchEffortDecision = {
  mode: EffortMode;
  confidence: number;
  reason: string;
  wantsDeliverable: boolean;
  needsCurrentInfo: boolean;
};

export type ResearchEffortGuard = {
  /** the heuristic's legal-signal regex fired on the query */
  legalSignal: boolean;
  historyTurns: number;
};

/**
 * Effort mode from the answers, or null for no opinion. Conversational needs
 * high confidence AND no legal subject (Jev or regex): a wrongly skipped
 * research turn is the costliest mistake. Fast needs confidence and no
 * deliverable. Everything else is think, the validated full loop.
 */
export function decideResearchEffort(
  res: SystemOneResult | null,
  guard: ResearchEffortGuard,
): ResearchEffortDecision | null {
  const a = choiceAnswer(res, "effort");
  if (!a) return null;
  const deliverable = noulAnswer(res, "wants_deliverable") ?? 0;
  const legal = noulAnswer(res, "legal_subject") ?? 1;
  const current = noulAnswer(res, "needs_current_info") ?? 0;
  const base = {
    confidence: a.confidence,
    wantsDeliverable: deliverable >= THRESHOLDS.researchDeliverableMin,
    needsCurrentInfo: current >= 0.5,
  };
  if (a.choice === "conversational") {
    const allowed =
      a.confidence >= THRESHOLDS.researchConversationalMinConfidence &&
      legal <= THRESHOLDS.researchLegalSubjectMax &&
      !guard.legalSignal &&
      // a reformat of a prior answer needs a prior answer; a bare greeting does not
      (guard.historyTurns > 0 || (a.probabilities["conversational"] ?? 0) >= 0.9);
    if (allowed) return { ...base, mode: "conversational", reason: "conversational (jev)" };
    return { ...base, mode: "think", reason: "conversational verdict vetoed -> think" };
  }
  if (a.choice === "fast") {
    if (base.wantsDeliverable) return { ...base, mode: "think", reason: "deliverable -> think" };
    if (a.confidence >= THRESHOLDS.researchFastMinConfidence) return { ...base, mode: "fast", reason: "single scoped lookup (jev)" };
    return { ...base, mode: "think", reason: `fast below confidence ${a.confidence.toFixed(2)} -> think` };
  }
  return { ...base, mode: "think", reason: "think (jev)" };
}

// --- Session memory: topic shift ---------------------------------------------------

export function topicShiftState(
  question: string,
  facts: readonly string[],
  summary: string,
): Record<string, unknown> {
  return {
    session: {
      facts: facts.slice(0, 15).map((f) => f.slice(0, 160)),
      summary: summary.slice(0, 1_200),
    },
    new_question: question.slice(0, 1_500),
  };
}

export function topicShiftQuestions(): Record<string, Question> {
  return {
    topic_shift: noul(
      {
        question:
          "Is `new_question` about a DIFFERENT legal matter or subject from the one `session.facts` and `session.summary` describe?",
        yes_when: "It names or clearly refers to a different case, MDL, product, party or legal issue than the session's.",
        no_when:
          "It continues the same matter, even from a new angle: its judge, a ruling or order in it, its schedule, its parties, its damages, or a request to reformat or expand what was already discussed.",
      },
      { true: "A different matter or subject", false: "The same matter or subject, or a follow-up on it" },
    ),
  };
}

/** true = clear the ledger, false = keep it, null = uncertain (caller falls back). */
export function decideTopicShift(res: SystemOneResult | null): boolean | null {
  const p = noulAnswer(res, "topic_shift");
  if (p === null) return null;
  if (p >= THRESHOLDS.topicShiftYes) return true;
  if (p <= THRESHOLDS.topicShiftNo) return false;
  return null;
}
