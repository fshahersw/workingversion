// ============================================================================
// One review cell: packed pages in, strict JSON answer out.
//
// Legacy single-call path (Claude / Fireworks). The Nemotron extract → check
// → verify pipeline lives in cell-pipeline.server.ts and is the default when
// REVIEW_PIPELINE_ENABLED is true. Parsing helpers are shared.
// ============================================================================
import {
  BEDROCK_PILE_WRITER_MODEL,
  bedrockClaudeEnabled,
  streamWriter,
} from "@/lib/agents/bedrock-claude.server";
import { FIREWORKS_PRECISE_MODEL, fireworksComplete, fireworksEnabled } from "@/lib/agents/fireworks.server";

import { checkCitations, firstJsonObject, normalizeValue, parseConfidence } from "./pipeline-core";
import { CELL_SYSTEM, buildCellUser } from "./prompt";
import { displayValue, type CellAnswer, type CellRequest } from "./types";

export function cellModel(): string {
  if (bedrockClaudeEnabled()) return BEDROCK_PILE_WRITER_MODEL;
  if (fireworksEnabled()) return FIREWORKS_PRECISE_MODEL;
  return "unconfigured";
}

async function complete(system: string, user: string, signal?: AbortSignal): Promise<string> {
  if (bedrockClaudeEnabled()) {
    const res = await streamWriter({
      model: BEDROCK_PILE_WRITER_MODEL,
      system,
      messages: [{ role: "user", content: user }],
      maxTokens: 1400,
      effort: "low",
      ...(signal ? { signal } : {}),
    });
    return res.text;
  }
  if (fireworksEnabled()) {
    return fireworksComplete({
      model: FIREWORKS_PRECISE_MODEL,
      system,
      user,
      maxTokens: 1400,
      temperature: 0,
      ...(signal ? { signal } : {}),
    });
  }
  throw new Error("No extraction model is configured");
}

export async function answerCell(req: CellRequest, signal?: AbortSignal): Promise<CellAnswer> {
  const pagesSearched = req.pages.map((p) => p.page);
  if (!req.pages.length) {
    return {
      value: null,
      display: "",
      status: "not_found",
      confidence: "high",
      citations: [],
      rationale: "No page in this document matched the question.",
    };
  }

  const text = await complete(CELL_SYSTEM, buildCellUser(req), signal);
  const parsed = firstJsonObject(text);
  if (!parsed) throw new Error("Model did not return a JSON object");

  const rawStatus = String(parsed["status"] ?? "").toLowerCase();
  const { verified } = checkCitations(parsed["citations"], req.pages, req.fileName);
  const value = normalizeValue(parsed, req.kind, req.options);
  const rationale = String(parsed["rationale"] ?? "").trim().slice(0, 600);
  const confidence = parseConfidence(parsed["confidence"]);

  if (rawStatus === "not_found" || value === null || value === "") {
    return {
      value: null,
      display: "",
      status: "not_found",
      confidence,
      citations: [],
      rationale: rationale || `Not addressed on pages ${pagesSearched.join(", ")}.`,
    };
  }

  const status =
    rawStatus === "needs_review" || verified.length === 0 || confidence === "low"
      ? "needs_review"
      : "answered";

  return {
    value,
    display: displayValue(value),
    status,
    confidence,
    citations: verified,
    rationale:
      verified.length === 0 && rationale
        ? `${rationale} (no verbatim quote could be verified)`
        : rationale,
  };
}
