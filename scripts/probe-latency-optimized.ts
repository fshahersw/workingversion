// Probe: does Bedrock Latency-Optimized Inference work for our Sonnet 5 in
// us-east-1? Sends the SAME tiny Converse request twice (standard vs optimized)
// and reports status + server-side latency so we can decide if it's a real,
// safe speed lever. Run:
//   AWS_PROFILE=AdministratorAccess-475976462949 AWS_REGION=us-east-1 \
//   bun run scripts/probe-latency-optimized.ts
import { signedBedrockFetch } from "../src/lib/agents/bedrock-sign.server";

const REGION = process.env["BEDROCK_REGION"] ?? process.env["AWS_REGION"] ?? "us-east-1";
const MODEL = process.env["BEDROCK_RESEARCH_MODEL"] || "us.anthropic.claude-sonnet-5";
const url = `https://bedrock-runtime.${REGION}.amazonaws.com/model/${encodeURIComponent(MODEL)}/converse`;

async function run(mode: "standard" | "optimized") {
  const body = {
    messages: [{ role: "user", content: [{ text: "Reply with exactly: OK" }] }],
    inferenceConfig: { maxTokens: 16 },
    performanceConfig: { latency: mode },
  };
  const t0 = Date.now();
  const res = await signedBedrockFetch(url, { body: JSON.stringify(body) });
  const wall = Date.now() - t0;
  const txt = await res.text();
  let latencyMs: number | undefined;
  let out = "";
  try {
    const j = JSON.parse(txt);
    latencyMs = j?.metrics?.latencyMs;
    out = j?.output?.message?.content?.[0]?.text ?? "";
  } catch { /* ignore */ }
  console.log(
    `[${mode}] http=${res.status} wall=${wall}ms serverLatency=${latencyMs ?? "?"}ms out=${JSON.stringify(out).slice(0, 40)}` +
      (res.ok ? "" : ` ERR=${txt.slice(0, 240)}`),
  );
  return res.ok;
}

(async () => {
  console.log(`model=${MODEL} region=${REGION}\n`);
  // Warm the standard path first (cold connections skew the first call).
  await run("standard");
  await run("standard");
  const ok = await run("optimized");
  await run("optimized");
  console.log(`\noptimized supported: ${ok ? "YES" : "NO (see ERR above)"}`);
})();
