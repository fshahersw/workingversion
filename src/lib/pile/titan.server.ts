import { signedBedrockFetch } from "@/lib/agents/bedrock-sign.server";

const REGION = process.env["BEDROCK_REGION"] ?? "us-east-1";
export const TITAN_EMBED_MODEL = "amazon.titan-embed-text-v2:0";

export async function embedText(text: string, signal?: AbortSignal): Promise<number[] | null> {
  const input = text.replace(/\s+/g, " ").trim().slice(0, 8000);
  if (!input) return null;
  const res = await signedBedrockFetch(
    `https://bedrock-runtime.${REGION}.amazonaws.com/model/${encodeURIComponent(TITAN_EMBED_MODEL)}/invoke`,
    {
      headers: { accept: "application/json" },
      body: JSON.stringify({ inputText: input, dimensions: 1024, normalize: true }),
      ...(signal ? { signal } : {}),
    },
  );
  if (!res.ok) {
    if (res.status === 429 || res.status >= 500) throw new Error(`Titan embed failed [${res.status}]`);
    return null;
  }
  const json = (await res.json()) as { embedding?: number[] };
  return Array.isArray(json.embedding) ? json.embedding : null;
}

export function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  const d = Math.sqrt(na) * Math.sqrt(nb);
  return d ? dot / d : 0;
}
