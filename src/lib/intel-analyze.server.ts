// Server-only AI analysis pass for the litigation intelligence run.
//
// Every story gets a one-sentence lead, 2-4 tight bullets and a "why it matters
// for mass tort practice" line. Results are cached in the corpus so page
// rendering never calls a model. Failures degrade gracefully: a story without
// analysis still ships with its plain summary.

import {
  BEDROCK_AGENT_MODEL,
  bedrockChat,
  bedrockEnabled,
  userText,
} from "@/lib/agents/bedrock.server";
import { parseJsonBlock } from "@/lib/agents/json-extract";

export type AnalysisInput = {
  key: string;
  title: string;
  source?: string | null;
  text?: string | null;
};

export type Analysis = { lead: string | null; bullets: string[]; impact: string | null };

const SYSTEM = [
  "You are a senior litigation analyst briefing mass tort and complex-litigation attorneys at a plaintiffs' firm.",
  "For each numbered item produce a dense, specific, non-generic briefing built only from the supplied text.",
  "lead: 1-2 sentences (max 45 words) stating exactly what happened, naming the court, judge, parties and posture.",
  "bullets: 4-7 bullets (max 32 words each), each prefixed with a short label and a colon.",
  "Use these labels where the text supports them, in this order:",
  "'Posture:' (procedural stance and what was decided),",
  "'Key facts:' (names, MDL/docket numbers, claim counts, dates),",
  "'Numbers:' (dollar figures, verdict/settlement amounts, claimant counts, deadlines),",
  "'Quote:' (a short verbatim quotation from the ruling, filing, judge or a named party, in quotation marks, attributed),",
  "'Context:' (how this fits the broader litigation, prior rulings, or the wider MDL landscape),",
  "'Signal:' (tone/sentiment of the court or parties — e.g. skeptical of defense experts, plaintiff-favorable, cautionary),",
  "'What's next:' (the next hearing, deadline, appeal window or expected step).",
  "Skip a label entirely rather than inventing content for it. Never repeat the lead in a bullet.",
  "impact: 1-2 sentences on the practical consequence for mass tort / complex-litigation practice —",
  "what it changes for case selection, expert strategy, discovery, valuation or timing.",
  "Never speculate, never hedge with filler, never restate the headline. Return JSON only.",
].join(" ");

function clip(v: string | null | undefined, n: number): string {
  return (v ?? "").replace(/\s+/g, " ").trim().slice(0, n);
}

async function analyzeBatch(
  batch: AnalysisInput[],
  errors: string[],
): Promise<Map<string, Analysis>> {
  const out = new Map<string, Analysis>();
  const prompt = batch
    .map((b, i) =>
      [
        `ITEM ${i + 1}`,
        `Title: ${clip(b.title, 300)}`,
        b.source ? `Source: ${clip(b.source, 80)}` : null,
        `Text: ${clip(b.text, 7000) || "(no extract available)"}`,
      ]
        .filter(Boolean)
        .join("\n"),
    )
    .join("\n\n");

  try {
    const result = await bedrockChat({
      model: BEDROCK_AGENT_MODEL,
      system: SYSTEM,
      messages: [
        userText(
          `${prompt}\n\nReturn JSON: {"items":[{"n":1,"lead":"...","bullets":["..."],"impact":"..."}]} covering every item in order.`,
        ),
      ],
      maxTokens: 2_000,
    });
    const parsed = parseJsonBlock(result.text, "items");
    const items = Array.isArray(parsed?.["items"]) ? parsed["items"] : [];
    for (const entry of items) {
      const o = entry as { n?: unknown; lead?: unknown; bullets?: unknown; impact?: unknown };
      const idx = typeof o.n === "number" ? o.n - 1 : -1;
      const target = batch[idx];
      if (!target) continue;
      out.set(target.key, {
        lead: typeof o.lead === "string" && o.lead.trim() ? clip(o.lead, 420) : null,
        bullets: Array.isArray(o.bullets)
          ? o.bullets
              .filter((b): b is string => typeof b === "string" && b.trim().length > 2)
              .slice(0, 7)
              .map((b) => clip(b, 320))
          : [],
        impact: typeof o.impact === "string" && o.impact.trim() ? clip(o.impact, 420) : null,
      });
    }
  } catch (e) {
    errors.push(`analysis: ${e instanceof Error ? e.message : String(e)}`);
  }
  return out;
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length) as R[];
  let cursor = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      for (;;) {
        const i = cursor++;
        if (i >= items.length) return;
        out[i] = await fn(items[i] as T);
      }
    }),
  );
  return out;
}

/**
 * Analyze up to `cap` items in batches. Never throws: a failed batch simply
 * yields no entries for those items.
 */
export async function analyzeItems(
  inputs: AnalysisInput[],
  opts: { cap?: number; batchSize?: number; concurrency?: number } = {},
): Promise<{ analyses: Map<string, Analysis>; errors: string[] }> {
  const errors: string[] = [];
  if (!bedrockEnabled()) {
    return { analyses: new Map(), errors: ["Bedrock credentials are not configured"] };
  }

  const cap = opts.cap ?? 80;
  const batchSize = opts.batchSize ?? 4;
  const slice = inputs.slice(0, cap);
  const batches: AnalysisInput[][] = [];
  for (let i = 0; i < slice.length; i += batchSize) batches.push(slice.slice(i, i + batchSize));

  const results = await mapLimit(batches, opts.concurrency ?? 4, (b) => analyzeBatch(b, errors));
  const analyses = new Map<string, Analysis>();
  for (const r of results) for (const [k, v] of r) analyses.set(k, v);
  return { analyses, errors };
}
