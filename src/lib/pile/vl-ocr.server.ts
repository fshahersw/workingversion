import { signedBedrockFetch } from "@/lib/agents/bedrock-sign.server";
import { HttpStatusError, parseRetryAfterMs } from "@/lib/pile/async";

const REGION = process.env["BEDROCK_REGION"] ?? "us-east-1";
export const NEMO_VL_MODEL = "nvidia.nemotron-nano-12b-v2";

function bytes(imageBase64: string): string {
  return imageBase64.replace(/^data:image\/\w+;base64,/, "").trim();
}

export async function ocrPageImage(imageBase64: string, signal?: AbortSignal): Promise<string> {
  const b64 = bytes(imageBase64);
  if (!b64) return "";
  const res = await signedBedrockFetch(
    `https://bedrock-runtime.${REGION}.amazonaws.com/model/${encodeURIComponent(NEMO_VL_MODEL)}/converse`,
    {
      body: JSON.stringify({
        system: [
          {
            text: [
              "You are a document OCR engine for U.S. litigation PDFs (PACER, pleadings, exhibits).",
              "Return ONLY the page text in reading order.",
              "Preserve headings, captions, stamps, Bates numbers, signatures, footnotes, and table structure (use | between cells).",
              "Do not paraphrase, summarize, translate, or add commentary.",
              "If the page is blank or wholly unreadable, reply with EMPTY.",
            ].join(" "),
          },
        ],
        messages: [
          {
            role: "user",
            content: [
              { image: { format: "jpeg", source: { bytes: b64 } } },
              { text: "Transcribe every readable word on this page." },
            ],
          },
        ],
        inferenceConfig: { maxTokens: 8192, temperature: 0 },
      }),
      ...(signal ? { signal } : {}),
    },
  );
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new HttpStatusError(
      res.status,
      `HTTP ${res.status}: Nano VL OCR failed: ${detail.slice(0, 240)}`,
      parseRetryAfterMs(res.headers.get("retry-after")),
    );
  }
  const json = (await res.json()) as {
    output?: { message?: { content?: { text?: string }[] } };
  };
  const text = (json.output?.message?.content ?? [])
    .map((b) => b.text ?? "")
    .join("\n")
    .trim();
  if (!text || text.toUpperCase() === "EMPTY") return "";
  return text;
}
