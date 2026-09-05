// Proves the review cell pipeline (extract -> check citations -> verify) runs
// over the SigV4 Converse transport with NO bearer token. Uses a synthetic page.
//   AWS_PROFILE=AdministratorAccess-475976462949 AWS_REGION=us-east-1 bun run scripts/test-cell-pipeline.ts
import { runCellPipeline } from "../src/lib/review/cell-pipeline.server";
import type { CellRequest } from "../src/lib/review/types";

delete process.env["AWS_BEARER_TOKEN_BEDROCK"];

const req: CellRequest = {
  columnName: "Effective date",
  question: "What is the effective date of this agreement?",
  kind: "date",
  options: [],
  instructions: null,
  fileName: "agreement.pdf",
  pages: [
    {
      page: 1,
      text:
        "MASTER SERVICES AGREEMENT\n\nThis Master Services Agreement (the “Agreement”) is " +
        "entered into and effective as of March 3, 2026 (the “Effective Date”) by and between " +
        "Acme Corp and Seeger Weiss LLP. The initial term is two (2) years.",
    },
  ],
};

async function main() {
  console.log("bearer present?:", !!process.env["AWS_BEARER_TOKEN_BEDROCK"], "(want false)\n");
  const t0 = Date.now();
  const ans = await runCellPipeline(req, { skipEscalate: true });
  console.log("value:      ", JSON.stringify(ans.value));
  console.log("display:    ", ans.display);
  console.log("status:     ", ans.status);
  console.log("confidence: ", ans.confidence);
  console.log("citations:  ", ans.citations.map((c) => `p${c.page}:"${c.quote.slice(0, 40)}"`).join(" | "));
  console.log("rationale:  ", ans.rationale.slice(0, 160));
  console.log(`\nran in ${Date.now() - t0}ms`);
  if (ans.status !== "answered" || !ans.citations.length) {
    throw new Error("pipeline did not answer with a citation");
  }
  console.log("CELL-PIPELINE TEST PASSED (SigV4 Converse, no bearer).");
}

main().catch((e) => {
  console.error("TEST FAILED:", e);
  process.exit(1);
});
