import assert from "node:assert/strict";
import { test } from "node:test";

import { detectClarification } from "./agents/clarify.ts";
import {
  composeSkill,
  filterSkills,
  RESEARCH_SKILLS,
  skillBySlash,
  slashDraft,
} from "./research-skills.ts";

const FRAME =
  "[Seeger Weiss LLP — plaintiffs' mass tort & complex litigation. Research focus: docket posture, bellwether schedule, and case-management orders]\n\n";

/** A skill's composed prompt must be specific enough that no panel is needed:
 *  the form already asked the attorney everything the detectors would. */
function panelFor(prompt: string): string {
  return detectClarification({ query: `${FRAME}${prompt}` })?.id ?? "none";
}

test("every skill has a unique slash and composes when required fields are set", () => {
  const slashes = RESEARCH_SKILLS.map((s) => s.slash);
  assert.equal(new Set(slashes).size, slashes.length);
  for (const skill of RESEARCH_SKILLS) {
    const values: Record<string, string> = {};
    for (const field of skill.fields) {
      if (field.required) values[field.id] = "Paraquat";
      if (field.id === "right") values[field.id] = "Roundup";
    }
    const prompt = composeSkill(skill, values);
    assert.ok(prompt && prompt.length > 40, skill.id);
    assert.equal(composeSkill(skill, {}), skill.fields.some((f) => f.required) ? null : prompt);
  }
});

test("bellwether compose settles the forum so the detector should not re-ask", () => {
  const skill = skillBySlash("bellwether");
  assert.ok(skill);
  const prompt = composeSkill(skill, { matter: "Depo-Provera", track: "federal" });
  assert.ok(prompt);
  assert.match(prompt, /federal MDL/);
  assert.match(prompt, /Depo-Provera/);
});

test("intake compose can pin jurisdiction and chat-only delivery", () => {
  const skill = skillBySlash("intake");
  assert.ok(skill);
  const prompt = composeSkill(skill, {
    product: "hernia mesh",
    jurisdictions: "Illinois",
    format: "chat",
  });
  assert.ok(prompt);
  assert.match(prompt, /Illinois/);
  assert.match(prompt, /do not generate a file/i);
});

test("no skill's composed prompt triggers a clarification panel", () => {
  // Required fields filled, optional ones blank — the case where a skill is
  // most likely to leave a fork open.
  for (const skill of RESEARCH_SKILLS) {
    const values: Record<string, string> = {};
    for (const field of skill.fields) {
      if (field.required) values[field.id] = field.id === "right" ? "Roundup" : "Paraquat MDL 3004";
    }
    const prompt = composeSkill(skill, values);
    assert.ok(prompt, skill.id);
    assert.equal(panelFor(prompt), "none", `${skill.id} (required only): ${prompt.slice(0, 120)}`);
  }
  // ...and again with every optional field filled in.
  const filled: Record<string, Record<string, string>> = {
    bellwether: { matter: "Depo-Provera", track: "state" },
    causation: { exposure: "talc", injury: "ovarian cancer", window: "last 5 years" },
    rule702: { left: "talc", right: "Roundup" },
    intake: { product: "hernia mesh", jurisdictions: "Illinois", format: "docx" },
    limitations: { claim: "paraquat Parkinson's", state: "IL" },
    docket: { case: "MDL 3004" },
    settlement: { matter: "AFFF" },
    recall: { product: "CPAP" },
  };
  for (const skill of RESEARCH_SKILLS) {
    const values = filled[skill.id];
    if (!values) continue;
    const prompt = composeSkill(skill, values);
    assert.ok(prompt, skill.id);
    assert.equal(panelFor(prompt), "none", `${skill.id} (filled): ${prompt.slice(0, 120)}`);
  }
});

test("the limitations skill pins its jurisdiction either way", () => {
  const skill = skillBySlash("sol");
  assert.ok(skill);
  const survey = composeSkill(skill, { claim: "paraquat Parkinson's" });
  assert.ok(survey);
  assert.match(survey, /Survey the key filing states/);
  const pinned = composeSkill(skill, { claim: "paraquat Parkinson's", state: "IL" });
  assert.ok(pinned);
  assert.match(pinned, /Limit the analysis to IL/);
});

test("the intake skill reads as a sentence when jurisdictions are blank", () => {
  const skill = skillBySlash("intake");
  assert.ok(skill);
  const prompt = composeSkill(skill, { product: "hernia mesh" });
  assert.ok(prompt);
  assert.match(prompt, /repose across the key filing states/);
  assert.ok(!/repose in survey/.test(prompt), "no 'in survey the key filing states'");
});

test("slash draft and filter are prefix-based", () => {
  assert.equal(slashDraft("/bel"), "bel");
  assert.equal(slashDraft("/bellwether x"), null);
  assert.equal(slashDraft("hello"), null);
  assert.ok(filterSkills("702").some((s) => s.id === "rule702"));
  assert.ok(filterSkills("sol").some((s) => s.id === "limitations"));
});
