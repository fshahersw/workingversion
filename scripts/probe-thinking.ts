// Phase 4 probe: how to control Sonnet 5 adaptive thinking on the Bedrock
// CONVERSE API. Field reports conflict on where the effort knob goes (and
// whether it validates at all), so this resolves it empirically instead of
// guessing. Uses the NON-streaming /converse endpoint (plain JSON) so parsing
// is trivial. For each candidate additionalModelRequestFields shape it prints:
// HTTP status + error, stopReason, whether the response carries a reasoningContent
// block, the answer text length, and token usage. Small + cheap.
//
//   AWS_REGION=us-east-1 bun run scripts/probe-thinking.ts
import { signedBedrockFetch } from "../src/lib/agents/bedrock-sign.server";

const REGION = process.env["BEDROCK_REGION"] ?? process.env["AWS_REGION"] ?? "us-east-1";
const MODEL = process.env["BEDROCK_RESEARCH_MODEL"] || "us.anthropic.claude-sonnet-5";
const URL = `https://bedrock-runtime.${REGION}.amazonaws.com/model/${encodeURIComponent(MODEL)}/converse`;

// Candidate shapes for additionalModelRequestFields (undefined = send none).
const CANDIDATES: { label: string; amrf?: Record<string, unknown> }[] = [
  { label: "none (default)", amrf: undefined },
  { label: "thinking.adaptive", amrf: { thinking: { type: "adaptive" } } },
  {
    label: "thinking.adaptive+effort(low)",
    amrf: { thinking: { type: "adaptive", effort: "low" } },
  },
  {
    label: "thinking.adaptive + output_config.effort(low)",
    amrf: { thinking: { type: "adaptive" }, output_config: { effort: "low" } },
  },
  { label: "output_config.effort(low) only", amrf: { output_config: { effort: "low" } } },
  {
    label: "thinking.adaptive + output_config.effort(high)",
    amrf: { thinking: { type: "adaptive" }, output_config: { effort: "high" } },
  },
  {
    label: "reasoning_config.enabled budget 1024",
    amrf: { reasoning_config: { type: "enabled", budget_tokens: 1024 } },
  },
];

type Block = Record<string, unknown>;

async function probe(label: string, amrf?: Record<string, unknown>): Promise<void> {
  const body: Record<string, unknown> = {
    system: [{ text: "You are a terse assistant." }],
    messages: [
      {
        role: "user",
        content: [
          {
            text: "A farmer has 17 sheep. All but 9 run away. How many are left? Give one line of reasoning, then the answer.",
          },
        ],
      },
    ],
    inferenceConfig: { maxTokens: 3000 },
    ...(amrf ? { additionalModelRequestFields: amrf } : {}),
  };

  let res: Response;
  try {
    res = await signedBedrockFetch(URL, { body: JSON.stringify(body) });
  } catch (err) {
    console.log(
      `- ${label}\n    NETWORK ERROR: ${err instanceof Error ? err.message : String(err)}`,
    );
    return;
  }

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    console.log(`- ${label}\n    HTTP ${res.status}: ${detail.slice(0, 240)}`);
    return;
  }

  const json = (await res.json()) as {
    output?: { message?: { content?: Block[] } };
    stopReason?: string;
    usage?: Record<string, number>;
  };
  const content = json.output?.message?.content ?? [];
  const hasReasoning = content.some((b) => "reasoningContent" in b);
  const textBlock = content.find((b) => typeof b["text"] === "string");
  const textLen = textBlock ? String(textBlock["text"]).length : 0;
  const kinds = content.map((b) => Object.keys(b)[0]).join(",");
  console.log(
    `- ${label}\n    OK stop=${json.stopReason} blocks=[${kinds}] reasoning=${hasReasoning} textLen=${textLen} usage=${JSON.stringify(json.usage ?? {})}`,
  );
}

async function main(): Promise<void> {
  console.log(`Probing thinking control on ${MODEL} via ${URL}\n`);
  for (const c of CANDIDATES) {
    await probe(c.label, c.amrf);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
