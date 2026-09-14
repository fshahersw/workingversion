// Shared vision-based image quality gate (server-only).
//
// Fetches a remote image and asks a vision model whether it is a clean,
// on-topic editorial/news image — as opposed to a bare logo, placeholder,
// broken/error graphic, tracker pixel, advertisement, or an unrelated picture.
//
// Fail-open on the model: a transport or model error returns "good" so a
// fetchable image is kept (the client still guards a broken <img>). An image
// that cannot be fetched at all returns false, so callers drop it.
//
// Used by the research-landing brief (`research-brief-enrich`) and the
// litigation-intelligence QA gate (`intel-qa`); keep the one implementation here.
import { BEDROCK_AGENT_MODEL } from "@/lib/agents/bedrock.server";
import { signedBedrockFetch } from "@/lib/agents/bedrock-sign.server";

const REGION = process.env["BEDROCK_REGION"] ?? "us-east-1";

export type ImgFmt = "png" | "jpeg" | "gif" | "webp";
export type FetchedImage = { bytes: string; format: ImgFmt };

export type ImageQaOpts = {
  /** Vision-capable model id; defaults to the cheap agent model (Haiku 4.5). */
  model?: string;
  region?: string;
  signal?: AbortSignal;
};

/** Fetch a remote image to base64, rejecting trackers/sprites and oversized
 *  payloads. Returns null on any failure (unsupported type, too small/large). */
export async function fetchImageB64(
  url: string,
  signal?: AbortSignal,
): Promise<FetchedImage | null> {
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

/** Vision verdict: is this a clean, on-topic legal-news image? Fail-open. */
export async function imageIsGood(
  img: FetchedImage,
  title: string,
  opts: ImageQaOpts = {},
): Promise<boolean> {
  const model = opts.model || BEDROCK_AGENT_MODEL;
  const region = opts.region || REGION;
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
      `https://bedrock-runtime.${region}.amazonaws.com/model/${encodeURIComponent(model)}/converse`,
      {
        body,
        headers: { accept: "application/json" },
        ...(opts.signal ? { signal: opts.signal } : {}),
      },
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

/**
 * Fetch and judge one image URL. Returns true only when it fetched AND passed
 * the vision gate (or the gate was unavailable → fail-open true for a fetchable
 * image). Returns false when the image cannot be fetched at all, so callers drop
 * it and fall back to a favicon.
 */
export async function imageUrlPassesQa(
  url: string,
  title: string,
  opts: ImageQaOpts = {},
): Promise<boolean> {
  const img = await fetchImageB64(url, opts.signal);
  if (!img) return false;
  return imageIsGood(img, title, opts);
}
