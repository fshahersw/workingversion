import assert from "node:assert/strict";
import { test } from "node:test";

import {
  COURT_STYLES,
  describeCourtStyle,
  findCourtStyle,
  listCourtStyles,
} from "./court-styles.ts";

test("every profile is complete, rule-cited and carries the verification note", () => {
  const ids = new Set<string>();
  for (const s of COURT_STYLES) {
    assert.ok(!ids.has(s.id), `duplicate id ${s.id}`);
    ids.add(s.id);
    assert.match(s.id, /^[a-z0-9-]+$/);
    assert.ok(s.source.length > 5);
    assert.ok(s.bodySizePt >= 10 && s.bodySizePt <= 14);
    assert.ok(s.footnoteSizePt >= 9 && s.footnoteSizePt <= 14);
    assert.ok([1, 1.5, 2].includes(s.lineSpacing));
    for (const side of Object.values(s.marginsIn)) assert.ok(side >= 0.5 && side <= 1.5);
    assert.ok(
      s.notes.some((n) => /Confirm against the current rule/.test(n)),
      `${s.id} lacks the verify note`,
    );
  }
});

test("FRAP profile matches Rule 32's stable requirements", () => {
  const frap = findCourtStyle("FRAP");
  assert.ok(frap);
  assert.equal(frap.bodySizePt, 14);
  assert.equal(frap.lineSpacing, 2);
  assert.deepEqual(frap.marginsIn, { top: 1, right: 1, bottom: 1, left: 1 });
  assert.equal(frap.fontRequired, false);
});

test("lookups are case-insensitive and unknown ids return null", () => {
  assert.equal(findCourtStyle("SDNY-EDNY")?.id, "sdny-edny");
  assert.equal(findCourtStyle("nope"), null);
  assert.equal(findCourtStyle(""), null);
  assert.equal(listCourtStyles().length, COURT_STYLES.length);
});

test("describeCourtStyle is a single readable paragraph with sizes and margins", () => {
  const text = describeCourtStyle(findCourtStyle("sdny-edny")!);
  assert.match(text, /body 12 pt, footnotes 10 pt/);
  assert.match(text, /double-spaced/);
  assert.match(text, /margins 1" all sides/);
  assert.match(text, /Local Civil Rule 11\.1/);
  const cal = describeCourtStyle(findCourtStyle("cal-superior")!);
  assert.match(cal, /right 0\.5"/);
});
