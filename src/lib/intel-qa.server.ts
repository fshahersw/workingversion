// Server-only quality-assurance gate for the litigation-intelligence run.
//
// Every collected story is reviewed before it is published to the terminal:
//   1) Text QA  — a batched Haiku pass decides approve/reject on relevance,
//      grounding (the briefing must be supported by the extracted article,
//      no fabricated facts), attribution, and prose quality.
//   2) Visual QA — approved stories with an image get a vision check (shared
//      `agents/image-qa`); a logo / placeholder / ad / off-topic thumbnail is
//      dropped so the card falls back to a favicon, while the story stays.
//
// Fail-open by design: if the model is unavailable the item is kept (status
// "approved", reason "qa_unavailable") rather than blanking the terminal, and
// the failure is surfaced in the run stats. The reader only shows "approved".
import {
  BEDROCK_AGENT_MODEL,
  bedrockChat,
  bedrockEnabled,
  userText,
} from "@/lib/agents/bedrock.server";
import { imageUrlPassesQa } from "@/lib/agents/image-qa.server";
import { parseJsonBlock } from "@/lib/agents/json-extract";

export type ReviewStatus = "approved" | "rejected" | "pending";
export type ImageReview = "kept" | "dropped" | "none" | "unchecked";

export type IntelReviewInput = {
  /** Stable key (canonical URL) used to join verdicts back to items. */
  key: string;
  title: string;
  source?: string | null;
  summary?: string | null;
  lead?: string | null;
  bullets?: string[];
  /** Extracted article body — the evidence grounding is judged against. */
  text?: string | null;
  category: string;
  imageUrl?: string | null;
};

export type IntelReview = {
  status: ReviewStatus;
  score: number;
  reasons: string[];
  imageReview: ImageReview;
};

export type IntelReviewStats = {
  reviewed: number;
  approved: number;
  rejected: number;
  pending: number;
  imagesChecked: number;
  imagesDropped: number;
  qaErrors: number;
};

const VISION_MODEL = process.env["BEDROCK_INTEL_VISION_MODEL"] || BEDROCK_AGENT_MODEL;

/** The model that produced the text verdicts; recorded on each item for audit. */
export const QA_TEXT_MODEL = BEDROCK_AGENT_MODEL;

/** How many stories get the full QA pass per run (top-ranked first). */
const TEXT_CAP = 150;
const TEXT_BATCH = 6;
const TEXT_CONCURRENCY = 4;
/** Cap the vision pass so a run never fans out to hundreds of image calls. */
const IMAGE_CAP = 90;
const IMAGE_CONCURRENCY = 8;

const SYSTEM = [
  "You are the editorial quality reviewer for a plaintiff-side mass-tort litigation intelligence feed.",
  "Decide whether each numbered item is fit to publish to attorneys. Judge four things:",
  "1) Relevance: it must genuinely concern litigation, mass tort / MDL, class actions, verdicts, settlements, regulatory or enforcement action, courts, or litigation-relevant science. Reject marketing, SEO spam, firm self-promotion, award lists, directory/webinar pages, and unrelated general business news.",
  "2) Grounding: when article text is supplied, the lead and bullets must be supported by it — reject items whose briefing asserts facts, numbers, quotes, parties or holdings that are NOT in the supplied text (fabrication). If NO article text is supplied, judge relevance and quality only; do NOT reject solely for missing evidence.",
  "3) Attribution: there should be an identifiable source/publisher.",
  "4) Quality: coherent, specific, non-duplicative, not clickbait or near-empty.",
  "Default to approve when the item is on-topic and not fabricated; reject only clear failures.",
  "Return JSON only.",
].join(" ");

function clip(v: string | null | undefined, n: number): string {
  return (v ?? "").replace(/\s+/g, " ").trim().slice(0, n);
}

async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
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
 * Map a model's JSON verdict text back onto a batch. Pure and deterministic
 * (no network) so it can be unit-tested. Fail-open: any item the model did not
 * cover — including when `text` is empty/unparseable — is kept as "approved"
 * with reason "qa_unavailable", so the terminal never goes blank.
 */
export function parseVerdicts(text: string, batch: IntelReviewInput[]): Map<string, IntelReview> {
  const out = new Map<string, IntelReview>();
  const parsed = parseJsonBlock(text, "items");
  const items = Array.isArray(parsed?.["items"]) ? parsed["items"] : [];
  for (const entry of items) {
    const o = entry as { n?: unknown; decision?: unknown; score?: unknown; reasons?: unknown };
    const idx = typeof o.n === "number" ? o.n - 1 : -1;
    const target = batch[idx];
    if (!target) continue;
    const rejected = typeof o.decision === "string" && /^rej/i.test(o.decision.trim());
    const score =
      typeof o.score === "number"
        ? Math.max(0, Math.min(100, Math.round(o.score)))
        : rejected
          ? 20
          : 70;
    const reasons = Array.isArray(o.reasons)
      ? o.reasons
          .filter((r): r is string => typeof r === "string" && r.trim().length > 1)
          .slice(0, 5)
          .map((r) => clip(r, 120))
      : [];
    out.set(target.key, {
      status: rejected ? "rejected" : "approved",
      score,
      reasons,
      imageReview: "unchecked",
    });
  }
  // Fail-open: anything the model did not return a verdict for is kept.
  for (const b of batch) {
    if (!out.has(b.key)) {
      out.set(b.key, {
        status: "approved",
        score: 60,
        reasons: ["qa_unavailable"],
        imageReview: "unchecked",
      });
    }
  }
  return out;
}

/** Review one batch for text quality. Fail-open on any model error. */
async function reviewTextBatch(
  batch: IntelReviewInput[],
  errors: string[],
): Promise<Map<string, IntelReview>> {
  const prompt = batch
    .map((b, i) =>
      [
        `ITEM ${i + 1}`,
        `Category: ${clip(b.category, 40) || "News"}`,
        `Title: ${clip(b.title, 300)}`,
        b.source ? `Source: ${clip(b.source, 80)}` : null,
        b.lead ? `Briefing lead: ${clip(b.lead, 400)}` : null,
        b.bullets && b.bullets.length
          ? `Briefing bullets: ${clip(b.bullets.join(" | "), 800)}`
          : null,
        `Article text: ${clip(b.text, 5000) || "(no extract available)"}`,
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
          `${prompt}\n\nReturn JSON: {"items":[{"n":1,"decision":"approve","score":0-100,"reasons":["short reason", "..."]}]} covering every item in order. "decision" is "approve" or "reject"; "score" is your confidence the item is fit to publish (0-100); "reasons" are short phrases (empty array if a clean approve).`,
        ),
      ],
      maxTokens: 1_500,
    });
    return parseVerdicts(result.text, batch);
  } catch (e) {
    errors.push(`qa: ${e instanceof Error ? e.message : String(e)}`);
    return parseVerdicts("", batch); // fail-open: keep the whole batch
  }
}

/**
 * Review the top-ranked stories for a run. `inputs` should already be ordered
 * best-first (by signal score); the cap applies to that order. Items beyond the
 * cap are returned as "pending" (retained but not published this run).
 * Never throws.
 */
export async function reviewIntelItems(
  inputs: IntelReviewInput[],
  opts: { cap?: number; signal?: AbortSignal } = {},
): Promise<{ reviews: Map<string, IntelReview>; stats: IntelReviewStats; errors: string[] }> {
  const signal = opts.signal;
  // A tighter cap (bounded/scheduled runs) keeps text + vision QA inside budget.
  const textCap = Math.min(Math.max(opts.cap ?? TEXT_CAP, 1), TEXT_CAP);
  const imageCap = Math.min(opts.cap ?? IMAGE_CAP, IMAGE_CAP);
  const errors: string[] = [];
  const reviews = new Map<string, IntelReview>();
  const stats: IntelReviewStats = {
    reviewed: 0,
    approved: 0,
    rejected: 0,
    pending: 0,
    imagesChecked: 0,
    imagesDropped: 0,
    qaErrors: 0,
  };

  if (!bedrockEnabled()) {
    // No model: keep everything (prior behavior), flagged for the run stats.
    for (const b of inputs) {
      reviews.set(b.key, {
        status: "approved",
        score: 50,
        reasons: ["qa_disabled"],
        imageReview: "none",
      });
    }
    stats.approved = inputs.length;
    stats.qaErrors = inputs.length ? 1 : 0;
    return { reviews, stats, errors: ["Bedrock credentials are not configured"] };
  }

  const reviewable = inputs.slice(0, textCap);
  const overflow = inputs.slice(textCap);

  // ---- text QA (batched) --------------------------------------------------
  const batches: IntelReviewInput[][] = [];
  for (let i = 0; i < reviewable.length; i += TEXT_BATCH) {
    batches.push(reviewable.slice(i, i + TEXT_BATCH));
  }
  const batchResults = await mapLimit(batches, TEXT_CONCURRENCY, (b) => reviewTextBatch(b, errors));
  for (const r of batchResults) for (const [k, v] of r) reviews.set(k, v);
  stats.qaErrors = errors.length;

  // Low-signal tail beyond the cap: retained but held (not published).
  for (const b of overflow) {
    reviews.set(b.key, {
      status: "pending",
      score: 0,
      reasons: ["below_review_cap"],
      imageReview: "none",
    });
  }

  // ---- visual QA (approved items with an image) ---------------------------
  const withImages = reviewable.filter((b) => {
    const v = reviews.get(b.key);
    return v?.status === "approved" && !!b.imageUrl;
  });
  const imageBatch = withImages.slice(0, imageCap);
  await mapLimit(imageBatch, IMAGE_CONCURRENCY, async (b) => {
    const v = reviews.get(b.key);
    if (!v || !b.imageUrl) return;
    const ok = await imageUrlPassesQa(b.imageUrl, b.title, {
      model: VISION_MODEL,
      ...(signal ? { signal } : {}),
    });
    v.imageReview = ok ? "kept" : "dropped";
  });
  // Approved items with an image we never reached stay "unchecked" → "none".
  for (const b of reviewable) {
    const v = reviews.get(b.key);
    if (v && v.imageReview === "unchecked") v.imageReview = b.imageUrl ? "kept" : "none";
  }

  // ---- tally --------------------------------------------------------------
  for (const v of reviews.values()) {
    stats.reviewed++;
    if (v.status === "approved") stats.approved++;
    else if (v.status === "rejected") stats.rejected++;
    else stats.pending++;
    if (v.imageReview === "kept" || v.imageReview === "dropped") stats.imagesChecked++;
    if (v.imageReview === "dropped") stats.imagesDropped++;
  }

  return { reviews, stats, errors };
}
