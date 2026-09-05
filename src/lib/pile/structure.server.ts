import { bedrockChat, BEDROCK_AGENT_MODEL, userText } from "@/lib/agents/bedrock.server";

import { samplePagesForStructure } from "./retrieve";
import type { PileStructure } from "./types";

export async function structureFromPages(input: {
  files: { name: string; pageCount: number }[];
  pages: Array<{ fileName: string; page: number; text: string }>;
  matterLabel?: string | null;
}): Promise<PileStructure> {
  const fallback: PileStructure = {
    inventory: input.files.map((f) => ({ file: f.name, docType: "other", pages: f.pageCount })),
    parties: [],
    dates: [],
    issues: [],
  };
  const map = samplePagesForStructure(input.pages, 8)
    .map((p) => `${p.fileName} p.${p.page}: ${(p.text || "(empty)").replace(/\s+/g, " ").slice(0, 220)}`)
    .join("\n");
  const res = await bedrockChat({
    model: BEDROCK_AGENT_MODEL,
    system: `You inventory a temporary litigation document pile. Return JSON only:
{"inventory":[{"file":"","docType":"","pages":0}],"parties":[],"dates":[],"issues":[]}
docType is one of: pleading, motion, order, transcript, expert, exhibit, correspondence, other.
Keep lists short and specific.`,
    messages: [
      userText(
        `${input.matterLabel ? `MATTER: ${input.matterLabel}\n` : ""}FILES:\n${input.files
          .map((f) => `- ${f.name} (${f.pageCount} pp)`)
          .join("\n")}\n\nPAGE MAP:\n${map}`,
      ),
    ],
    maxTokens: 2500,
    temperature: 0.1,
  });
  const match = res.text.match(/\{[\s\S]*\}/);
  if (!match) return fallback;
  try {
    const parsed = JSON.parse(match[0]) as PileStructure;
    return {
      inventory: Array.isArray(parsed.inventory) ? parsed.inventory : fallback.inventory,
      parties: Array.isArray(parsed.parties) ? parsed.parties.map(String).slice(0, 20) : [],
      dates: Array.isArray(parsed.dates) ? parsed.dates.map(String).slice(0, 20) : [],
      issues: Array.isArray(parsed.issues) ? parsed.issues.map(String).slice(0, 20) : [],
    };
  } catch {
    return fallback;
  }
}
