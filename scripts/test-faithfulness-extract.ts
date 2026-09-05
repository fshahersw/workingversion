// Deterministic unit check for the faithfulness claim extractor.
//
// Reproduces every pathology the multi-case calibration (bp3ohww88) surfaced —
// table rows, multi-citation sentences, model hedges, legal abbreviations — and
// asserts the hardened extractClaims() yields only clean, whole sentences with
// the right refs. No model call, no AWS, no network: pure and instant.
//
//   bun run scripts/test-faithfulness-extract.ts
import { extractClaims } from "../src/lib/agents/faithfulness.server";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  const tag = cond ? "PASS" : "FAIL";
  if (!cond) failures++;
  console.log(`  [${tag}] ${name}${detail && !cond ? ` — ${detail}` : ""}`);
}

// 1) Multi-citation sentence -> ONE unit, both refs, no mid-sentence fragment.
{
  const answer =
    "The Ninth Circuit affirmed the Zhang exclusion and summary judgment [S1], and separately affirmed exclusion of a specific-causation expert [S2]. The court declined to reach the remaining issues [S3].";
  const units = extractClaims(answer);
  console.log("Case 1 — multi-cite sentence:");
  for (const u of units) console.log(`   • {${u.refs.join(",")}} ${u.claim}`);
  check("two units (one per sentence)", units.length === 2, `got ${units.length}`);
  check(
    "first unit carries BOTH refs",
    units[0]?.refs.join(",") === "S1,S2",
    units[0]?.refs.join(","),
  );
  check(
    "no unit starts with a comma/conjunction fragment",
    units.every((u) => !/^(,|and\b|but\b|or\b)/i.test(u.claim)),
    units.map((u) => u.claim).join(" | "),
  );
  check(
    "first claim is the whole sentence",
    units[0]?.claim.startsWith("The Ninth Circuit affirmed") === true,
    units[0]?.claim,
  );
}

// 2) Table rows (leading pipe AND inline pipes) are dropped, including a hedge.
{
  const answer =
    "Here are the settlement figures below.\n\n" +
    "| Defendant | Amount | Ref |\n" +
    "| --- | --- | --- |\n" +
    "| Tyco | I could not pull a specific dollar figure for the Tyco settlement [S5] |\n" +
    "| BASF | $316M [S6] |\n\n" +
    "The water-provider class settlement totaled roughly $12.5 billion [S7].";
  const units = extractClaims(answer);
  console.log("Case 2 — table rows dropped:");
  for (const u of units) console.log(`   • {${u.refs.join(",")}} ${u.claim}`);
  check("only the prose sentence survives", units.length === 1, `got ${units.length}`);
  check(
    "the table hedge is NOT a claim",
    units.every((u) => !/could not pull/i.test(u.claim)),
  );
  check(
    "surviving claim is the prose sentence",
    units[0]?.claim.startsWith("The water-provider class settlement") === true,
    units[0]?.claim,
  );
}

// 3) Legal abbreviations must not split a sentence.
{
  const answer =
    "The court in Doe v. Acme Corp., No. 21-1234 (S.D.N.Y. 2023) denied the motion under Fed. R. Civ. P. 12(b)(6) [S2].";
  const units = extractClaims(answer);
  console.log("Case 3 — abbreviations:");
  for (const u of units) console.log(`   • {${u.refs.join(",")}} ${u.claim}`);
  check("stays one sentence", units.length === 1, `got ${units.length}`);
  check("full sentence preserved", (units[0]?.claim.length ?? 0) > 60, units[0]?.claim);
}

// 4) Fragments / short labels below threshold are rejected.
{
  const answer = "Background [S1]. The plaintiffs alleged design-defect and failure-to-warn theories [S2].";
  const units = extractClaims(answer);
  console.log("Case 4 — fragment rejection:");
  for (const u of units) console.log(`   • {${u.refs.join(",")}} ${u.claim}`);
  check("the 'Background' fragment is dropped", units.length === 1, `got ${units.length}`);
  check(
    "only the real sentence remains",
    units[0]?.claim.startsWith("The plaintiffs alleged") === true,
    units[0]?.claim,
  );
}

// 5) Duplicate sentences dedupe.
{
  const answer =
    "The MDL was consolidated in the Northern District of Illinois [S1]. The MDL was consolidated in the Northern District of Illinois [S2].";
  const units = extractClaims(answer);
  console.log("Case 5 — dedupe:");
  for (const u of units) console.log(`   • {${u.refs.join(",")}} ${u.claim}`);
  check("identical sentences collapse to one", units.length === 1, `got ${units.length}`);
}

console.log(`\n${failures === 0 ? "ALL PASS" : `${failures} FAILURE(S)`}`);
process.exit(failures === 0 ? 0 : 1);
