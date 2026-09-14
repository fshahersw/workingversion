// Server-only "Ask about this" answer for a single litigation-intelligence story.
//
// Pulls the FULL article at ask-time (Firecrawl scrape of the story URL) and
// answers the user's question with the cheap agent model (Haiku 4.5, large
// context), grounded strictly in that story's briefing + full text. Never
// invents: if the article can't be fetched it answers from the briefing and
// says so. Fail-safe on every step.
import {
  BEDROCK_AGENT_MODEL,
  bedrockChat,
  bedrockEnabled,
  userText,
} from "@/lib/agents/bedrock.server";
import type { IntelAnswer, IntelAskInput } from "@/lib/intel-types";

const FIRECRAWL_SCRAPE = "https://api.firecrawl.dev/v2/scrape";
/** Large but bounded article budget (~10k tokens) for Haiku's big context. */
const ARTICLE_CHARS = 40_000;

const clip = (v: string | null | undefined, n: number): string =>
  (v ?? "").replace(/\s+/g, " ").trim().slice(0, n);

/** Fetch the full article body as markdown. Best-effort; null on any failure. */
async function scrapeArticle(url: string, signal?: AbortSignal): Promise<string | null> {
  const key = process.env["FIRECRAWL_API_KEY"];
  if (!key) return null;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 20_000);
  signal?.addEventListener("abort", () => ctrl.abort(), { once: true });
  try {
    const res = await fetch(FIRECRAWL_SCRAPE, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
      body: JSON.stringify({
        url,
        formats: ["markdown"],
        onlyMainContent: true,
        timeout: 15000,
        blockAds: true,
      }),
      signal: ctrl.signal,
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { data?: { markdown?: string } };
    const md = typeof body.data?.markdown === "string" ? body.data.markdown : "";
    return md.trim() || null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

const SYSTEM = [
  "You are a senior litigation analyst at a plaintiffs' mass-tort firm answering a colleague's question about ONE news story.",
  "Answer ONLY from the story context provided (the briefing and, when present, the full article text).",
  "Be specific and name the publisher/source. If the answer is not in the provided context, say so plainly and name the primary record that would confirm it — never invent facts, holdings, numbers, dates, or quotes.",
  "Keep it tight: a direct, litigation-relevant answer in 2-5 sentences. No preamble, no restating the headline.",
].join(" ");

export async function answerIntelQuestion(
  input: IntelAskInput,
  signal?: AbortSignal,
): Promise<IntelAnswer> {
  const question = clip(input.question, 600);
  if (!question) return { answer: "Ask a question about this story.", grounded: "briefing" };
  if (!bedrockEnabled()) {
    return {
      answer: "The analysis model is not configured in this environment.",
      grounded: "briefing",
    };
  }

  const article = input.url ? await scrapeArticle(input.url, signal) : null;
  const context = [
    `Headline: ${clip(input.title, 300)}`,
    input.source ? `Publisher: ${clip(input.source, 120)}` : null,
    input.publishedAt ? `Published: ${clip(input.publishedAt, 40)}` : null,
    input.url ? `URL: ${clip(input.url, 400)}` : null,
    input.lead ? `Briefing: ${clip(input.lead, 600)}` : null,
    input.bullets && input.bullets.length
      ? `Key points: ${clip(input.bullets.join(" | "), 1200)}`
      : null,
    input.impact ? `Why it matters: ${clip(input.impact, 600)}` : null,
    input.summary ? `Summary: ${clip(input.summary, 1200)}` : null,
    article
      ? `\nFull article text:\n${clip(article, ARTICLE_CHARS)}`
      : "\n(The full article could not be retrieved — answer from the briefing above, and say so if a detail is not present in it.)",
  ]
    .filter(Boolean)
    .join("\n");

  try {
    const res = await bedrockChat({
      model: BEDROCK_AGENT_MODEL,
      system: SYSTEM,
      messages: [userText(`STORY CONTEXT\n${context}\n\nQUESTION: ${question}`)],
      maxTokens: 700,
      ...(signal ? { signal } : {}),
    });
    return {
      answer: res.text.trim() || "No answer was produced.",
      grounded: article ? "article" : "briefing",
    };
  } catch (e) {
    return {
      answer: `Could not answer right now (${e instanceof Error ? e.message : "error"}).`,
      grounded: article ? "article" : "briefing",
    };
  }
}
