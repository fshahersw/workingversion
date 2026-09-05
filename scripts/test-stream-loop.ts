// Isolation test of the streaming tool loop: streams narration live to stdout,
// executes research tools in parallel, loops. Proves ConverseStream+tools works.
//   AWS_PROFILE=AdministratorAccess-475976462949 AWS_REGION=us-east-1 bun run scripts/test-stream-loop.ts
import { streamConverseToolLoop } from "../src/lib/agents/bedrock-stream-tools.server";
import { RESEARCH_TOOLS, executeResearchTool } from "../src/lib/agents/research-tools.server";
import { SourceBook } from "../src/lib/agents/tools.server";
import { researchAgentPrompt } from "../src/lib/agents/prompts";

delete process.env["AWS_BEARER_TOKEN_BEDROCK"];

async function main() {
  const q = process.argv[2] ||
    "What is the current posture of the AFFF MDL 2873 in the District of South Carolina, and what did the most recent case management order address?";
  const book = new SourceBook();
  const t0 = Date.now();
  let chars = 0;

  const res = await streamConverseToolLoop(
    {
      model: "us.anthropic.claude-sonnet-5",
      system: researchAgentPrompt(),
      user: `QUESTION\n${q}\n\nResearch this with your tools (call them in parallel where independent), then output your findings digest.`,
      tools: RESEARCH_TOOLS,
      maxTokens: 2000,
      maxSteps: 6,
      cache: true,
      callBudget: { perTool: 4, total: 18 },
      deadlineMs: 45_000,
    },
    {
      onText: (d) => { chars += d.length; process.stdout.write(d); },
      onStep: (s) => process.stdout.write(`\n  ⟦step ${s.step} · ${s.ms}ms · stop=${s.stopReason} · tools=[${s.toolCalls.join(", ")}]⟧\n`),
      onToolUse: (c) => process.stdout.write(`\n  → ${c.name}(${JSON.stringify(c.input).slice(0, 80)})\n`),
      execute: async (c) => (await executeResearchTool(c.name, c.input, book)).text,
    },
  );

  console.log(`\n\n=== ${((Date.now() - t0) / 1000).toFixed(1)}s · steps=${res.steps} · sources=${book.all().length} · streamed ${chars} narration chars ===`);
  if (chars === 0) { console.log("NO NARRATION STREAMED"); process.exit(1); }
  console.log("STREAMING TOOL LOOP OK.");
}
main().catch((e) => { console.error("\nFAILED:", e); process.exit(1); });
