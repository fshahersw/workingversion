import assert from "node:assert/strict";
import { test } from "node:test";

import { checkBluebook, normalizeReporter, type Finding } from "./bluebook.ts";

const byKind = (findings: Finding[], kind: Finding["kind"]) =>
  findings.filter((f) => f.kind === kind);

test("normalizeReporter maps common variants to Bluebook T1 forms", () => {
  assert.equal(normalizeReporter("F. 3d"), "F.3d");
  assert.equal(normalizeReporter("F.3d"), "F.3d");
  assert.equal(normalizeReporter("F.Supp.3d"), "F. Supp. 3d");
  assert.equal(normalizeReporter("S.Ct."), "S. Ct.");
  assert.equal(normalizeReporter("Fed. Appx."), "F. App'x");
  assert.equal(normalizeReporter("So.2d"), "So. 2d");
  assert.equal(normalizeReporter("U. S."), "U.S.");
  assert.equal(normalizeReporter("Not a reporter"), null);
});

test("a correctly formatted brief produces no findings", () => {
  const text = [
    "See Daubert v. Merrell Dow Pharms., Inc., 509 U.S. 579, 589 (1993).",
    "In re Roundup Prods. Liab. Litig., 390 F. Supp. 3d 1102, 1108 (N.D. Cal. 2018); Hardeman v. Monsanto Co., 997 F.3d 941, 960 (9th Cir. 2021).",
    "See, e.g., 28 U.S.C. § 1407; Fed. R. Civ. P. 26(a)(2); 21 C.F.R. § 201.57.",
    "Id. at 12. Smith v. Jones, No. 21-cv-1234, 2024 WL 123456, at *3 (S.D.N.Y. Mar. 3, 2024).",
  ].join(" ");
  const report = checkBluebook(text);
  assert.equal(report.findings.length, 0, JSON.stringify(report.findings, null, 1));
  assert.equal(report.citations.length, 4);
  assert.match(report.summary, /no Bluebook form issues/);
});

test("reporter spacing and ordinal errors carry a drop-in suggestion scoped to the citation", () => {
  const text =
    "Hardeman v. Monsanto Co., 997 F. 3d 941 (9th Cir. 2021); Jones v. Acme, 12 F. Supp 34 (D.N.J. 2020); Doe v. Roe, 5 F. 3rd 6 (2d Cir. 1990).";
  const { findings } = checkBluebook(text);
  const rep = byKind(findings, "reporter");
  assert.equal(rep.length, 2);
  assert.deepEqual(
    rep.map((f) => [f.found, f.suggestion]),
    [
      ["997 F. 3d 941", "997 F.3d 941"],
      ["12 F. Supp 34", "12 F. Supp. 34"],
    ],
  );
  const ord = byKind(findings, "ordinal");
  assert.equal(ord.length, 1);
  assert.equal(ord[0]!.suggestion, "5 F.3d 6");
  assert.equal(ord[0]!.rule, "R6.2(b)(iii)");
  for (const f of findings) assert.equal(f.occurrences, 1);
});

test("missing or incomplete court/year parentheticals are reported without inventing values", () => {
  const { findings, citations } = checkBluebook(
    "Hardeman v. Monsanto Co., 997 F.3d 941. See also Jones v. Acme, 12 F. Supp. 3d 34 (2020). Smith, 509 U.S. 579 (U.S. Sup. Ct. 1993).",
  );
  assert.equal(citations.length, 3);
  const paren = byKind(findings, "parenthetical");
  assert.equal(paren.length, 1);
  assert.equal(paren[0]!.found, "997 F.3d 941");
  assert.equal(paren[0]!.suggestion, undefined);
  const court = byKind(findings, "court");
  assert.equal(court.length, 2);
  assert.ok(court.some((f) => f.found === "(2020)" && /district/.test(f.message)));
  const scotus = court.find((f) => f.found === "(U.S. Sup. Ct. 1993)");
  assert.equal(scotus?.suggestion, "(1993)");
});

test("unreported citations need a full-date parenthetical and T12 month abbreviations", () => {
  const { findings } = checkBluebook(
    "Smith v. Jones, 2024 WL 123456, at *3 (S.D.N.Y. September 3, 2024). Doe v. Roe, 2023 WL 999 (D.N.J. Sep. 1, 2023). Lee v. Kim, 2022 WL 555.",
  );
  const months = byKind(findings, "month");
  assert.deepEqual(months.map((f) => [f.found, f.suggestion]).sort(), [
    ["Sep.", "Sept."],
    ["September", "Sept."],
  ]);
  const paren = byKind(findings, "parenthetical");
  assert.equal(paren.length, 1);
  assert.equal(paren[0]!.found, "2022 WL 555");
  assert.equal(paren[0]!.severity, "error");
});

test("short forms, signals, pinpoints, statutes and rules", () => {
  const text =
    "Id at 12. Id., at 14. Ibid. See e.g. Smith. Cf Jones. 42 USC §1983; 21 CFR § 201.57; FRCP 26; Fed.R.Evid. 702. Hardeman, 997 F.3d 941, at p. 960 (9th Cir. 2021).";
  const { findings } = checkBluebook(text);
  const pairs = new Map(findings.map((f) => [f.found, f.suggestion]));
  assert.equal(pairs.get("Id at"), "Id. at");
  assert.equal(pairs.get("Id., at"), "Id. at");
  assert.equal(pairs.get("Ibid."), "Id.");
  assert.equal(pairs.get("See e.g."), "See, e.g.,");
  // "Cf" is a prefix of its fix, so the finding is bound to the following space
  assert.equal(pairs.get("Cf "), "Cf. ");
  assert.equal(pairs.get("USC"), "U.S.C.");
  assert.equal(pairs.get("§1983"), "§ 1983");
  assert.equal(pairs.get("CFR"), "C.F.R.");
  assert.equal(pairs.get("FRCP"), "Fed. R. Civ. P.");
  assert.equal(pairs.get("Fed.R.Evid."), "Fed. R. Evid.");
  assert.equal(pairs.get(", at p. 960"), ", at 960");
  // prose "id at" without a locator is left alone
  assert.equal(checkBluebook("the user id at the top of the form").findings.length, 0);
});

test("a fix never matches an already-correct citation (prefix-shaped findings are delimiter-bound)", () => {
  const text =
    "See 42 U.S.C. § 1983 and 28 U.S.C §1331; 21 C.F.R. § 201.57 and 21 C.F.R §314.80. Cf. Smith; Cf Doe. " +
    "See, e.g., Roe; See, e.g. Poe. Argued (Jan. 3, 2024); decided 2024 WL 1 (Jan 5, 2024).";
  const { findings } = checkBluebook(text);
  for (const f of findings) {
    if (f.suggestion === undefined) continue;
    // Applying the fix as a plain replace-all must leave every correct form intact.
    const fixed = text.split(f.found).join(f.suggestion);
    assert.ok(!fixed.includes("U.S.C.."), `${JSON.stringify(f.found)} mangled U.S.C.`);
    assert.ok(!fixed.includes("C.F.R.."), `${JSON.stringify(f.found)} mangled C.F.R.`);
    assert.ok(!fixed.includes("Cf.."), `${JSON.stringify(f.found)} mangled Cf.`);
    assert.ok(!fixed.includes("e.g.,,"), `${JSON.stringify(f.found)} mangled See, e.g.,`);
    assert.ok(!fixed.includes("Jan.."), `${JSON.stringify(f.found)} mangled Jan.`);
    // and the occurrence count is the number of wrong instances the replace will touch
    assert.equal(f.occurrences, text.split(f.found).length - 1);
  }
  const pairs = new Map(findings.map((f) => [f.found, f.suggestion]));
  assert.equal(pairs.get("U.S.C "), "U.S.C. ");
  assert.equal(pairs.get("C.F.R "), "C.F.R. ");
  assert.equal(pairs.get("Cf "), "Cf. ");
  assert.equal(pairs.get("See, e.g. "), "See, e.g., ");
  assert.equal(pairs.get("Jan "), "Jan. ");
});

test("WL cites with 7-digit document numbers are parsed and want a full date", () => {
  const { citations, findings } = checkBluebook("Smith v. Jones, 2023 WL 4567890 (S.D.N.Y. 2023).");
  assert.equal(citations.length, 1);
  assert.equal(citations[0]!.page, "4567890");
  assert.ok(findings.some((f) => /full date|exact date|date/i.test(f.message)), "WL cite without a full date must be flagged");
});

test("findings are capped and errors sort before warnings", () => {
  const many = Array.from({ length: 30 }, (_, i) => `Case ${i}, ${100 + i} F. 3d ${i + 1}.`).join(
    " ",
  );
  const report = checkBluebook(many, { maxFindings: 10 });
  assert.equal(report.findings.length, 10);
  assert.match(report.summary, /showing 10 of/);
  assert.ok(report.findings.every((f) => f.severity === "error"));
});
