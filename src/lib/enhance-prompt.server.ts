// Server-only "Enhance my prompt" meta-tool. Rewrites a lawyer's short or vague
// prompt into a structured legal request BEFORE it is sent to the model —
// surfacing the implicit role, jurisdiction, audience, scope, output format,
// constraints, and citation expectations, while preserving the user's own
// wording and never pre-answering the prompt.
//
// Distilled from the LegalQuants "Enhance Prompt" skill (SKILL.md +
// preserve_user_voice + expansion_patterns). Uses the cheap agent model
// (Haiku 4.5, nice prose). Fail-safe: on any error it returns the original.
import {
  BEDROCK_AGENT_MODEL,
  bedrockChat,
  bedrockEnabled,
  userText,
} from "@/lib/agents/bedrock.server";
import type { EnhanceInput, EnhanceResult } from "@/lib/enhance-prompt.functions";

const clip = (v: string | null | undefined, n: number): string =>
  (v ?? "").replace(/\s+/g, " ").trim().slice(0, n);

const SYSTEM = [
  "You are Enhance Prompt, a meta-assistant at a plaintiffs' litigation firm. You rewrite a colleague's short or vague prompt into a clearer, more effective prompt BEFORE it is sent to a legal AI. You do NOT answer the prompt; you improve it.",
  "Make the implicit explicit. Surface only the elements that are actually missing AND relevant, drawn from: role (default: in-house/litigation counsel), jurisdiction, audience, scope, output format, constraints, and citation expectations.",
  "Preserve the user's voice: keep their substantive verbs and nouns, their hedging, their stated constraints (e.g. 'in two paragraphs', 'no legalese'), and their level of detail. A short prompt yields a short expansion (target 2-5x the input length, never more).",
  "Never invent legal substance, a perspective/side, or a specific jurisdiction the user did not signal. Never smuggle an answer into the prompt. Never add politeness padding or marketing language. If jurisdiction matters but none is given, note the US-default assumption rather than inventing one.",
  "If the user is on a specific side or a document is in scope only because they said so, reflect that; otherwise do not assert it.",
  "Multi-task prompts: preserve the structure (do not collapse two asks into one). Legal-advice or outcome-prediction prompts ('should I sign', 'will I win'): reframe to a review/analysis framing ('review for issues to inform the decision') — do not produce a recommendation. Non-legal prompts: still enhance using general role/audience/format heuristics.",
  "SKIP (set expansion_applied=false, echo the original as expanded_prompt, give a short skip_reason) when the prompt is already well-structured (roughly >80 words with explicit format/scope), is conversational, is a follow-up continuing a prior task, is a direct operational ask ('summarize the upload', 'format as a table'), or the user opted out.",
  "If the user supplied a 'What to improve' note, treat it as explicit instruction for how to rewrite and honor it.",
  'Respond with STRICT JSON only, no markdown fences, no prose outside the object: {"expansion_applied": boolean, "expanded_prompt": string, "reasoning": string[], "skip_reason": string|null}. reasoning is 2-6 short plain-language bullets that each explain the VALUE of a change ("Naming in-house counsel keeps the answer in the right voice for your audience"), written for the user, never referencing confidential content.',
].join(" ");

function parseResult(text: string, original: string): EnhanceResult {
  const cleaned = text.replace(/```json/gi, "").replace(/```/g, "").trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start >= 0 && end > start) {
    try {
      const obj = JSON.parse(cleaned.slice(start, end + 1)) as {
        expansion_applied?: unknown;
        expanded_prompt?: unknown;
        reasoning?: unknown;
        skip_reason?: unknown;
      };
      const expanded =
        typeof obj.expanded_prompt === "string" && obj.expanded_prompt.trim()
          ? obj.expanded_prompt.trim()
          : original;
      const reasoning = Array.isArray(obj.reasoning)
        ? obj.reasoning
            .filter((x): x is string => typeof x === "string")
            .map((x) => x.trim())
            .filter(Boolean)
            .slice(0, 8)
        : [];
      const skipReason =
        typeof obj.skip_reason === "string" && obj.skip_reason.trim() ? obj.skip_reason.trim() : null;
      const applied = obj.expansion_applied !== false && expanded !== original;
      return {
        applied,
        expandedPrompt: expanded,
        reasoning,
        skipReason: applied ? null : (skipReason ?? "Your prompt is already clear — no changes needed."),
      };
    } catch {
      /* fall through to text fallback */
    }
  }
  // No parseable JSON: treat a substantive reply as the expansion, else skip.
  const t = cleaned.trim();
  if (t && t.length >= Math.max(24, original.length)) {
    return { applied: true, expandedPrompt: t, reasoning: [], skipReason: null };
  }
  return {
    applied: false,
    expandedPrompt: original,
    reasoning: [],
    skipReason: "Could not generate an enhancement right now.",
  };
}

export async function enhancePrompt(
  input: EnhanceInput,
  signal?: AbortSignal,
): Promise<EnhanceResult> {
  const prompt = clip(input.prompt, 6000);
  if (!prompt) {
    return { applied: false, expandedPrompt: "", reasoning: [], skipReason: "Enter a prompt to enhance." };
  }
  if (!bedrockEnabled()) {
    return {
      applied: false,
      expandedPrompt: prompt,
      reasoning: [],
      skipReason: "The enhancement model is not configured in this environment.",
    };
  }

  const improve = clip(input.improve, 1500);
  const jurisdiction = clip(input.jurisdiction, 120);
  const request = [
    `ORIGINAL PROMPT:\n${prompt}`,
    improve ? `\nWHAT TO IMPROVE (user instruction):\n${improve}` : "",
    jurisdiction ? `\nUSER DEFAULT JURISDICTION: ${jurisdiction}` : "",
    "\nReturn the structured JSON described in your instructions.",
  ]
    .filter(Boolean)
    .join("\n");

  try {
    const res = await bedrockChat({
      model: BEDROCK_AGENT_MODEL,
      system: SYSTEM,
      messages: [userText(request)],
      maxTokens: 1200,
      ...(signal ? { signal } : {}),
    });
    return parseResult(res.text ?? "", prompt);
  } catch (e) {
    return {
      applied: false,
      expandedPrompt: prompt,
      reasoning: [],
      skipReason: `Could not enhance right now (${e instanceof Error ? e.message : "error"}).`,
    };
  }
}
