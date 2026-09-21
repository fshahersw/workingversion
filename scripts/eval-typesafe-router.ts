// ============================================================================
// Evaluate the Jev (TypeSafe) router questions on synthetic, labeled sets.
//
//   $env:TYPESAFE_API_KEY = "..."; bun scripts/eval-typesafe-router.ts [--office] [--research] [--json out.json]
//
// Reports, per router: accuracy against the labels, a confusion table, the
// share of "no opinion" (below threshold) verdicts, confidence by correctness,
// latency p50/p90 and input tokens per call. For research it also reports
// agreement with the regex heuristic (classifyEffort) so shadow-mode numbers
// have a baseline. Everything here is synthetic text; no client data.
// Thresholds live in src/lib/agents/typesafe-questions.ts — tune there.
// ============================================================================
import { writeFileSync } from "node:fs";

import { classifyEffort, hasLegalSignal } from "../src/lib/research-intent";
import {
  decideOfficeClass,
  decideResearchEffort,
  officeRouteQuestions,
  officeRouteState,
  researchEffortQuestions,
  researchEffortState,
  type OfficeApp,
  type OfficeTaskClass,
} from "../src/lib/agents/typesafe-questions";
import { choiceAnswer, systemOne, typesafeConfigured, typesafeModel } from "../src/lib/agents/typesafe.server";

type OfficeCase = { app: OfficeApp; text: string; label: OfficeTaskClass };
type ResearchCase = { text: string; history: number; label: "conversational" | "fast" | "think" };

const OFFICE: OfficeCase[] = [
  // inspect
  { app: "writer", text: "What does the third section say about the statute of limitations?", label: "inspect" },
  { app: "writer", text: "How many footnotes cite the Hardeman opinion?", label: "inspect" },
  { app: "writer", text: "Check whether every citation in this brief is in Bluebook form", label: "inspect" },
  { app: "sheets", text: "Which custodian has the most withheld documents in this log?", label: "inspect" },
  { app: "sheets", text: "Is the total in column F consistent with the line items?", label: "inspect" },
  { app: "slides", text: "Summarize what this deck argues in three sentences", label: "inspect" },
  { app: "slides", text: "Which slides mention the settlement timeline?", label: "inspect" },
  { app: "writer", text: "Compare the damages figures in section 4 with the ones in the appendix and tell me if they match", label: "inspect" },
  // format
  { app: "writer", text: "Make all headings Times New Roman 14 point and bold", label: "format" },
  { app: "writer", text: "Double-space the body text and set one-inch margins", label: "format" },
  { app: "writer", text: "Repeat the header row of the exhibit table on every page", label: "format" },
  { app: "writer", text: "Switch this section to landscape", label: "format" },
  { app: "sheets", text: "Freeze the header row and autofit the column widths", label: "format" },
  { app: "sheets", text: "Format column D as currency with two decimals and band the rows", label: "format" },
  { app: "slides", text: "Align these three text boxes and make the title fonts consistent across the deck", label: "format" },
  { app: "slides", text: "Use the firm's navy for all slide titles", label: "format" },
  // short_edit
  { app: "writer", text: "Change the hearing date in the first paragraph to March 3, 2026", label: "short_edit" },
  { app: "writer", text: "Fix the typo in the second sentence of the conclusion", label: "short_edit" },
  { app: "writer", text: "Rename 'Defendant Corp' to 'Acme Pharmaceuticals, Inc.' throughout", label: "short_edit" },
  { app: "writer", text: "Add a footnote after the first sentence citing Fed. R. Civ. P. 26", label: "short_edit" },
  { app: "sheets", text: "Put the total of column C in C42", label: "short_edit" },
  { app: "sheets", text: "Add a row for Q4 with the same formulas as the row above", label: "short_edit" },
  { app: "slides", text: "Delete slide 7", label: "short_edit" },
  { app: "slides", text: "Replace the chart image on slide 3 with the new one I attached", label: "short_edit" },
  // draft
  { app: "writer", text: "Draft a two-page memo summarizing the status of the talc MDL for the client", label: "draft" },
  { app: "writer", text: "Write an introduction section for this brief based on the argument headings", label: "draft" },
  { app: "writer", text: "Rewrite the entire letter in a more formal tone", label: "draft" },
  { app: "writer", text: "Restructure this memo so the recommendation comes first", label: "draft" },
  { app: "sheets", text: "Build a settlement allocation model with tiers by injury category and a payout waterfall", label: "draft" },
  { app: "sheets", text: "Create a privilege log template with the standard columns and sample rows", label: "draft" },
  { app: "slides", text: "Build a ten-slide deck from these notes for the case team meeting", label: "draft" },
  { app: "slides", text: "Add three slides explaining the bellwether schedule", label: "draft" },
  // analyze
  { app: "writer", text: "Assess the weaknesses in our preemption argument and suggest how opposing counsel will attack it", label: "analyze" },
  { app: "writer", text: "Which of the cases cited in section II still support our position after the 2025 Third Circuit decision?", label: "analyze" },
  { app: "writer", text: "Review the expert's methodology section for Daubert vulnerabilities", label: "analyze" },
  { app: "writer", text: "Reconcile the two damages models in the appendix and explain which assumptions drive the difference", label: "analyze" },
  { app: "sheets", text: "Model the sensitivity of the settlement fund to a 20 percent change in claimant participation and explain the risk", label: "analyze" },
  { app: "sheets", text: "Analyze whether the billing entries show a pattern consistent with block billing", label: "analyze" },
  { app: "slides", text: "Evaluate whether this deck's litigation risk assessment is sound and what it leaves out", label: "analyze" },
  { app: "slides", text: "Research the recent rulings across the three MDLs and synthesize them into an argument for the strategy slide", label: "analyze" },
];

const RESEARCH: ResearchCase[] = [
  // conversational
  { text: "thanks, that's helpful", history: 2, label: "conversational" },
  { text: "make that shorter", history: 2, label: "conversational" },
  { text: "put that in a table", history: 3, label: "conversational" },
  { text: "who are you and what can you do", history: 0, label: "conversational" },
  { text: "hello", history: 0, label: "conversational" },
  { text: "rephrase your last answer in plain English", history: 1, label: "conversational" },
  { text: "ok got it", history: 4, label: "conversational" },
  { text: "can you say that again as bullets", history: 2, label: "conversational" },
  // fast
  { text: "What is the current status of MDL 2738?", history: 0, label: "fast" },
  { text: "When is the next Roundup bellwether trial scheduled?", history: 0, label: "fast" },
  { text: "What does Fed. R. Civ. P. 26(a)(2) require for expert disclosures?", history: 0, label: "fast" },
  { text: "Who is the presiding judge in the Zantac MDL?", history: 1, label: "fast" },
  { text: "Did the court rule on the motion to dismiss in the Bard port catheter MDL?", history: 0, label: "fast" },
  { text: "What is the statute of limitations for product liability in New Jersey?", history: 0, label: "fast" },
  { text: "Has the JPML issued a transfer order for the Depo-Provera cases?", history: 0, label: "fast" },
  { text: "What did the Third Circuit hold in Fosamax on preemption?", history: 2, label: "fast" },
  // think
  { text: "Compare the Daubert rulings in the Zantac and Roundup MDLs and tell me what they mean for our general causation experts", history: 0, label: "think" },
  { text: "Give me a comprehensive update on talc litigation: recent rulings, settlement posture, and upcoming trial dates in every venue", history: 0, label: "think" },
  { text: "Draft a memo on preemption risk for our valsartan cases", history: 0, label: "think" },
  { text: "What are the pros and cons of opting into the proposed settlement versus continuing to litigate?", history: 1, label: "think" },
  { text: "Walk me through how the courts have treated learned intermediary defenses in device cases across the Fifth and Ninth Circuits", history: 0, label: "think" },
  { text: "Analyze the FDA warning letter history for this manufacturer and how it connects to the failure-to-warn theory", history: 0, label: "think" },
  { text: "Prepare a research report on the medical monitoring claims available in each of the twelve states where we have clients", history: 0, label: "think" },
  { text: "How do the recent Supreme Court decisions on class certification affect our strategy, and what should we file next?", history: 2, label: "think" },
];

const pct = (n: number, d: number) => (d ? `${((100 * n) / d).toFixed(1)}%` : "n/a");
const quantile = (xs: number[], q: number) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(q * s.length))]!;
};

function confusion<T extends string>(rows: Array<{ label: T; got: T | "none" }>, labels: T[]): string {
  const cols = [...labels, "none"] as Array<T | "none">;
  const head = `${"label \\ got".padEnd(16)}${cols.map((c) => c.padStart(14)).join("")}`;
  const lines = labels.map((l) => {
    const counts = cols.map((c) => rows.filter((r) => r.label === l && r.got === c).length);
    return `${l.padEnd(16)}${counts.map((n) => String(n).padStart(14)).join("")}`;
  });
  return [head, ...lines].join("\n");
}

async function evalOffice(): Promise<Record<string, unknown>> {
  const rows: Array<{ label: OfficeTaskClass; got: OfficeTaskClass | "none"; confidence: number; ms: number; tokens: number; text: string }> = [];
  for (const c of OFFICE) {
    const res = await systemOne({ purpose: "eval_office", state: officeRouteState(c.app, c.text), questions: officeRouteQuestions(), timeoutMs: 5_000, retries: 1 });
    const d = decideOfficeClass(res);
    rows.push({
      label: c.label,
      got: d?.taskClass ?? "none",
      confidence: choiceAnswer(res, "task_class")?.confidence ?? -1,
      ms: res?.ms ?? -1,
      tokens: res?.usage.inputTokens ?? 0,
      text: c.text,
    });
  }
  const decided = rows.filter((r) => r.got !== "none");
  const correct = rows.filter((r) => r.got === r.label);
  // Safety view: a wrong down-route (cheap tier chosen for a heavy label) is the costly mistake.
  const heavy = new Set<OfficeTaskClass>(["draft", "analyze"]);
  const wrongDown = rows.filter((r) => heavy.has(r.label) && r.got !== "none" && !heavy.has(r.got as OfficeTaskClass));
  console.log(`\n=== Office task class (${rows.length} cases, model ${typesafeModel()}) ===`);
  console.log(`accuracy (decided): ${pct(correct.length, decided.length)}   no-opinion: ${pct(rows.length - decided.length, rows.length)}   wrong down-routes: ${wrongDown.length}`);
  console.log(`latency p50 ${quantile(rows.map((r) => r.ms), 0.5)} ms, p90 ${quantile(rows.map((r) => r.ms), 0.9)} ms; input tokens/call ~${Math.round(rows.reduce((n, r) => n + r.tokens, 0) / rows.length)}`);
  console.log(confusion(rows, ["inspect", "format", "short_edit", "draft", "analyze"]));
  for (const r of rows.filter((x) => x.got !== x.label)) console.log(`  miss: [${r.label} -> ${r.got} @${r.confidence.toFixed(2)}] ${r.text}`);
  return { rows, accuracy: correct.length / Math.max(1, decided.length), wrongDown: wrongDown.length };
}

async function evalResearch(): Promise<Record<string, unknown>> {
  const rows: Array<{ label: ResearchCase["label"]; got: ResearchCase["label"] | "none"; heuristic: string; confidence: number; ms: number; tokens: number; text: string }> = [];
  for (const c of RESEARCH) {
    const res = await systemOne({ purpose: "eval_research", state: researchEffortState(c.text, c.history), questions: researchEffortQuestions(), timeoutMs: 5_000, retries: 1 });
    const d = decideResearchEffort(res, { legalSignal: hasLegalSignal(c.text), historyTurns: c.history });
    rows.push({
      label: c.label,
      got: d?.mode ?? "none",
      heuristic: classifyEffort(c.text, c.history).mode,
      confidence: choiceAnswer(res, "effort")?.confidence ?? -1,
      ms: res?.ms ?? -1,
      tokens: res?.usage.inputTokens ?? 0,
      text: c.text,
    });
  }
  const correct = rows.filter((r) => r.got === r.label);
  const heuristicCorrect = rows.filter((r) => r.heuristic === r.label);
  const missedResearch = rows.filter((r) => r.label !== "conversational" && r.got === "conversational");
  console.log(`\n=== Research effort (${rows.length} cases, model ${typesafeModel()}) ===`);
  console.log(`jev accuracy: ${pct(correct.length, rows.length)}   heuristic accuracy: ${pct(heuristicCorrect.length, rows.length)}   research turns wrongly skipped: ${missedResearch.length}`);
  console.log(`latency p50 ${quantile(rows.map((r) => r.ms), 0.5)} ms, p90 ${quantile(rows.map((r) => r.ms), 0.9)} ms; input tokens/call ~${Math.round(rows.reduce((n, r) => n + r.tokens, 0) / rows.length)}`);
  console.log(confusion(rows, ["conversational", "fast", "think"]));
  for (const r of rows.filter((x) => x.got !== x.label)) console.log(`  miss: [${r.label} -> ${r.got} @${r.confidence.toFixed(2)}; heuristic ${r.heuristic}] ${r.text}`);
  return { rows, accuracy: correct.length / rows.length, heuristicAccuracy: heuristicCorrect.length / rows.length, missedResearch: missedResearch.length };
}

async function main(): Promise<void> {
  if (!typesafeConfigured()) {
    console.error("TYPESAFE_API_KEY is not set in this shell; export it (never commit it) and rerun.");
    process.exit(2);
  }
  const args = new Set(process.argv.slice(2));
  const both = !args.has("--office") && !args.has("--research");
  const out: Record<string, unknown> = { model: typesafeModel(), at: new Date().toISOString() };
  if (both || args.has("--office")) out["office"] = await evalOffice();
  if (both || args.has("--research")) out["research"] = await evalResearch();
  const jsonIdx = process.argv.indexOf("--json");
  if (jsonIdx > 0 && process.argv[jsonIdx + 1]) {
    writeFileSync(process.argv[jsonIdx + 1]!, JSON.stringify(out, null, 2));
    console.log(`\nwrote ${process.argv[jsonIdx + 1]}`);
  }
}

void main();
