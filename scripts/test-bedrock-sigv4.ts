// Proves the SigV4 Bedrock transport works with NO bearer token — auth comes
// entirely from the default credential chain (SSO here).
//   AWS_PROFILE=AdministratorAccess-475976462949 AWS_REGION=us-east-1 bun run scripts/test-bedrock-sigv4.ts
import { bedrockChat, userText } from "../src/lib/agents/bedrock.server";
import { streamBedrockClaude } from "../src/lib/agents/bedrock-claude.server";
import { embedText } from "../src/lib/pile/titan.server";

// Guarantee we are NOT accidentally using a bearer token.
delete process.env["AWS_BEARER_TOKEN_BEDROCK"];

async function main() {
  console.log("bearer token present?:", !!process.env["AWS_BEARER_TOKEN_BEDROCK"], "(want false)\n");

  // 1. Converse (nemotron) — the extract/verify/rerank/structure path.
  const conv = await bedrockChat({
    model: "nvidia.nemotron-nano-3-30b",
    system: "You are terse.",
    messages: [userText("/no_think Reply with the single word: ok")],
    maxTokens: 10,
  });
  console.log("1. converse (nemotron):", JSON.stringify(conv.text.trim().slice(0, 40)), "| tokens:", conv.usage);

  // 2. InvokeModel (Titan embeddings) — pile/scratch embedding path.
  const emb = await embedText("hello seegerweiss");
  console.log("2. titan invoke embed: dims =", emb?.length, "(want 1024)");

  // 3. invoke-with-response-stream (Claude Sonnet 5) — writer / escalation path.
  let streamed = "";
  const claude = await streamBedrockClaude(
    { model: "us.anthropic.claude-sonnet-5", system: "You are terse.", messages: [{ role: "user", content: "Reply with the single word: ok" }], maxTokens: 12000, effort: "low" },
    { onText: (d) => { streamed += d; } },
  );
  console.log("3. claude invoke-stream:", JSON.stringify(claude.text.trim().slice(0, 40)), "| stop:", claude.stopReason);

  if (!conv.text.trim() || !emb || emb.length !== 1024 || !claude.text.trim()) {
    throw new Error("one or more Bedrock paths returned empty/wrong output");
  }
  console.log("\nSIGV4 BEDROCK TEST PASSED (no bearer token used).");
}

main().catch((e) => {
  console.error("TEST FAILED:", e);
  process.exit(1);
});
