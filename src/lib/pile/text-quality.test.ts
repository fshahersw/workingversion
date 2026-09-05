import assert from "node:assert/strict";
import { test } from "node:test";

import { isLowQualityText, textQualityScore } from "./text-quality.ts";

test("clean pleading text scores high", () => {
  const t =
    "The court denied the motion to dismiss. Plaintiffs allege a Daubert challenge to the epidemiology expert.";
  assert.ok(textQualityScore(t) > 0.7);
  assert.equal(isLowQualityText(t), false);
});

test("PACER-style garbage scores low", () => {
  const t =
    "If there is any possibility of you bec9ming pregnant you must abs,ain fn:,m siexu;,1 relations or use a medically";
  assert.ok(textQualityScore(t) < 0.55);
  assert.equal(isLowQualityText(t), true);
});

test("character-spaced OCR scores low", () => {
  const t =
    "My m enca l acc i cude was Impr oved by partici pa: i ng in this study 6 30 1·s 3 2";
  assert.equal(isLowQualityText(t), true);
});

test("empty is low quality", () => {
  assert.equal(textQualityScore(""), 0);
  assert.equal(isLowQualityText("   "), true);
});
