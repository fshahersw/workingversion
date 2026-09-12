/**
 * Optional Bedrock enrichment of the research-landing brief. Runs ONCE inside the
 * cached 6h build (never per page render), so it adds no per-load latency after
 * the first miss. Every step FAILS SAFE: a disabled flag, missing creds, a model
 * error, or a parse failure leaves the deterministic template prompt in place and
 * keeps the image (the client still guards a broken <img>). Uses the cheap agent
 * model (Haiku 4.5), already in the runtime Bedrock allow-list.
 *
 * Two steps:
 *  1) enrichQuestions — one sharp, matter-specific litigator question per headline
 *     for the card CTA (replaces the flat "Ask about this").
 *  2) verifyImages — a vision-model quality gate that drops logo-only / broken /
 *     placeholder / off-topic thumbnails so only clean news images survive.
 */
import { BEDROCK_AGENT_MODEL, bedrockChat, bedrockEnabled, userText } from "./agents/bedrock.server.ts";
import { signedBedrockFetch } from "./agents/bedrock-sign.server.ts";
import type { ResearchHeadline } from "./research-brief.ts";

const REGION = process.env["BEDROCK_REGION"] ?? "us-east-1";
/** Vision-capable model for the image gate; Haiku 4.5 accepts image blocks. */
const VISION_MODEL = process.env["BEDROCK_BRIEF_VISION_MODEL"] || BEDROCK_AGENT_MODEL;

const flagOff = (v: string | undefined): boolean => /^(0|off|false|no)$/i.test((v ?? "").trim());
export const questionsEnabled = (): boolean =>
  bedrockEnabled() && !flagOff(process.env["RESEARCH_BRIEF_PROMPTS"]);
export const imageCheckEnabled = (): boolean =>
  bedrockEnabled() && !flagOff(process.env["RESEARCH_BRIEF_IMAGE_CHECK"]);

const QUESTION_SYSTEM =
  "You brief a plaintiff-side mass-tort litigation team. For each news item about a matter the firm is actively researching, write ONE sharp, specific question a senior litigator would click to pull real strategic value — e.g. docket / bellwether posture, settlement leverage, Daubert or general-causation exposure, PSC / CMO or MDL steering implications, or cross-jurisdiction read-through. Be concrete to THIS item; never generic ('tell me more', 'what happened'). Max 16 words, end with '?'. Return ONLY a JSON array of strings, one per item, in the given order.";

/** Generate one incisive question per headline; sets `question`. Never throws. */
export async function enrichQuestions(
  headlines: ResearchHeadline[],
  signal?: AbortSignal,
): Promise<void> {
  if (!headlines.length || !questionsEnabled()) return;
  const items = headlines.map((h) => ({
    matter: h.topic,
    headline: h.title,
    summary: (h.snippet || "").slice(0, 400),
  }));
  try {
    const res = await bedrockChat({
      model: BEDROCK_AGENT_MODEL,
      system: QUESTION_SYSTEM,
      messages: [userText(JSON.stringify(items))],
      maxTokens: 512,
      ...(signal ? { signal } : {}),
    });
    const parsed = JSON.parse(res.text.replace(/^```(?:json)?\s*/, "").replace(/\s*```$/, ""));
    if (!Array.isArray(parsed)) return;
    headlines.forEach((h, i) => {
      const q = typeof parsed[i] === "string" ? parsed[i].trim() : "";
      if (q && q.length <= 200) h.question = q;
    });
  } catch {
    /* keep the deterministic template prompt */
  }
}

type ImgFmt = "png" | "jpeg" | "gif" | "webp";

async function fetchImageB64(
  url: string,
  signal?: AbortSignal,
): Promise<{ bytes: string; format: ImgFmt } | null> {
  try {
    const res = await fetch(url, {
      redirect: "follow",
      signal: signal ?? AbortSignal.timeout(4000),
      headers: { accept: "image/*" },
    });
    if (!res.ok) return null;
    const ct = (res.headers.get("content-type") || "").toLowerCase();
    const format: ImgFmt | null = ct.includes("png")
      ? "png"
      : ct.includes("gif")
        ? "gif"
        : ct.includes("webp")
          ? "webp"
          : ct.includes("jpeg") || ct.includes("jpg")
            ? "jpeg"
            : null;
    if (!format) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    // Reject 1x1 trackers / near-empty sprites and oversized payloads.
    if (buf.length < 1024 || buf.length > 3_500_000) return null;
    return { bytes: buf.toString("base64"), format };
  } catch {
    return null;
  }
}

/** Vision verdict: is this a clean, on-topic news thumbnail? Fail-open. */
async function imageIsGood(
  img: { bytes: string; format: ImgFmt },
  title: string,
  signal?: AbortSignal,
): Promise<boolean> {
  const body = JSON.stringify({
    messages: [
      {
        role: "user",
        content: [
          { image: { format: img.format, source: { bytes: img.bytes } } },
          {
            text:
              `This image is the thumbnail for a legal-news headline: "${title.slice(0, 200)}". ` +
              "Is it a clear, legible, on-topic news or editorial image suitable to show beside that headline? " +
              'Answer "no" if it is a broken / placeholder / error graphic, a bare logo or wordmark, a near-blank or 1x1 image, an advertisement, or unrelated. ' +
              "Reply with exactly one word: yes or no.",
          },
        ],
      },
    ],
    inferenceConfig: { maxTokens: 4, temperature: 0 },
  });
  try {
    const res = await signedBedrockFetch(
      `https://bedrock-runtime.${REGION}.amazonaws.com/model/${encodeURIComponent(VISION_MODEL)}/converse`,
      { body, headers: { accept: "application/json" }, ...(signal ? { signal } : {}) },
    );
    if (!res.ok) return true; // fail-open: keep a fetchable image; client onError still guards
    const data = (await res.json()) as { output?: { message?: { content?: { text?: string }[] } } };
    const text = (data.output?.message?.content ?? [])
      .map((c) => c.text ?? "")
      .join(" ")
      .toLowerCase();
    return !/\bno\b/.test(text); // keep unless the model clearly says "no"
  } catch {
    return true; // fail-open
  }
}

/** Drop imageUrl on headlines whose thumbnail is unfetchable or fails the vision
 *  quality gate, so the card falls back to a clean favicon. Never throws. */
export async function verifyImages(
  headlines: ResearchHeadline[],
  signal?: AbortSignal,
): Promise<void> {
  if (!imageCheckEnabled()) return;
  await Promise.all(
    headlines.map(async (h) => {
      if (!h.imageUrl) return;
      const img = await fetchImageB64(h.imageUrl, signal);
      if (!img || !(await imageIsGood(img, h.title, signal))) h.imageUrl = undefined;
    }),
  );
}
