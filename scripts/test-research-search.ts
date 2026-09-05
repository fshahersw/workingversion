// Exercises the refactored research search module (agentcore-search.server.ts)
// end to end: category key -> IAM gateway general___WebSearch -> parsed results,
// SigV4 via the default credential chain (no static SEARCH_AWS_* keys).
//   AWS_PROFILE=AdministratorAccess-475976462949 AWS_REGION=us-east-1 bun run scripts/test-research-search.ts
import { agentCoreSearch, agentCoreConfigured } from "../src/lib/agents/agentcore-search.server";

delete process.env["AWS_BEARER_TOKEN_BEDROCK"];
delete process.env["SEARCH_AWS_ACCESS_KEY_ID"];
delete process.env["SEARCH_AWS_SECRET_ACCESS_KEY"];

const probes: [Parameters<typeof agentCoreSearch>[0], string][] = [
  ["case_law", "AFFF MDL 2873 District of South Carolina recent order"],
  ["scientific_research", "PFAS exposure kidney cancer epidemiology study"],
];

async function main() {
  console.log("agentCoreConfigured():", agentCoreConfigured(), "| SEARCH keys set:", !!process.env["SEARCH_AWS_ACCESS_KEY_ID"], "\n");
  let ok = 0;
  for (const [cat, q] of probes) {
    const t0 = Date.now();
    const results = await agentCoreSearch(cat, q, 5);
    console.log(`[${cat}] "${q}" -> ${results.length} results in ${Date.now() - t0}ms`);
    for (const r of results.slice(0, 3)) {
      console.log(`   - ${String(r.title ?? "").slice(0, 66)} | ${String(r.url ?? "").slice(0, 60)}`);
    }
    if (results.length) ok++;
    console.log("");
  }
  if (ok === 0) throw new Error("no category returned results");
  console.log(`RESEARCH SEARCH MODULE WORKS (${ok}/${probes.length} categories returned results, no static keys).`);
}

main().catch((e) => {
  console.error("FAILED:", e);
  process.exit(1);
});
