// End-to-end test of the single research agent: pre-pass -> Sonnet 5 tool loop
// -> streaming answer. Exercises AgentCore web search, DocketBird, CourtListener
// RECAP, and fetch_page live. bun auto-loads .env (tokens); needs AWS creds.
//   AWS_PROFILE=AdministratorAccess-475976462949 AWS_REGION=us-east-1 bun run scripts/test-research-agent.ts
import { runResearchAgent } from "../src/lib/agents/research-agent.server";

async function main() {
  const q = process.argv[2] ||
    "What is the current posture of the AFFF Products Liability MDL 2873 in the District of South Carolina, and what did the most recent case management order address?";
  console.log("Q:", q, "\n");

  const counts: Record<string, number> = {};
  const toolCalls: string[] = [];
  let sources = 0;
  let answer = "";
  const t0 = Date.now();

  const emit = (event: string, data: Record<string, unknown>) => {
    counts[event] = (counts[event] ?? 0) + 1;
    if (event === "tool_call" && data["hits"] !== undefined) toolCalls.push(`${data["tool"]}(${data["hits"]})`);
    if (event === "sources") sources = Array.isArray(data["sources"]) ? (data["sources"] as unknown[]).length : sources;
    if (event === "delta") answer += String((data as { text?: string }).text ?? "");
    if (event === "agent_done") console.log("DIGEST:", String((data as { summary?: string }).summary ?? "").slice(0, 400), "\n");
    if (event === "error") console.log("ERROR EVENT:", data);
  };

  await runResearchAgent({ query: q }, emit as never);

  console.log(`\n=== ${((Date.now() - t0) / 1000).toFixed(1)}s ===`);
  console.log("tool calls:", toolCalls.join(", ") || "(none)");
  console.log("sources:", sources, "| events:", Object.entries(counts).map(([k, v]) => `${k}:${v}`).join(" "));
  console.log("\n=== ANSWER ===\n", answer.trim().slice(0, 2500));
  if (!answer.trim()) { console.log("\nNO ANSWER PRODUCED"); process.exit(1); }
}
main().catch((e) => { console.error("FAILED:", e); process.exit(1); });
