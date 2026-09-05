import { BEDROCK_AGENT_MODEL, bedrockChat, userText } from "@/lib/agents/bedrock.server";

import { parseRerankIds } from "./retrieve";
import type { PileHit, PileStructure } from "./types";

export async function rerankPileHits(
  query: string,
  structure: PileStructure | null,
  hits: PileHit[],
  k: number,
  signal?: AbortSignal,
): Promise<PileHit[]> {
  if (hits.length <= k) return hits;
  try {
    const candidates = hits
      .map((h) => `${h.fileId}:${h.page} | ${h.fileName} p.${h.page}${h.ocr ? " (VL OCR)" : ""}\n${h.snippet}`)
      .join("\n\n");
    const res = await bedrockChat({
      model: BEDROCK_AGENT_MODEL,
      system: `You are a litigation retrieval reranker. Return JSON only: {"ids":["fileId:page",...]}
Pick the ${k} most useful pages for answering the question, best first. Use only ids listed in CANDIDATES.`,
      messages: [
        userText(
          `QUESTION\n${query}\n\nPILE\n${JSON.stringify({
            parties: structure?.parties ?? [],
            issues: structure?.issues ?? [],
            files: structure?.inventory ?? [],
          })}\n\nCANDIDATES\n${candidates}`,
        ),
      ],
      maxTokens: 800,
      temperature: 0,
      ...(signal ? { signal } : {}),
    });
    const ids = parseRerankIds(res.text, k);
    const byId = new Map(hits.map((h) => [`${h.fileId}:${h.page}`, h]));
    const picked = ids.map((id) => byId.get(id)).filter((h): h is PileHit => !!h);
    if (picked.length >= Math.min(4, hits.length, k)) {
      const seen = new Set(picked.map((h) => `${h.fileId}:${h.page}`));
      const rest = hits.filter((h) => !seen.has(`${h.fileId}:${h.page}`));
      return [...picked, ...rest].slice(0, k);
    }
  } catch {
    /* keep first-pass ranking */
  }
  return hits.slice(0, k);
}
