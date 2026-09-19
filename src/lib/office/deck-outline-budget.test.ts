import assert from "node:assert/strict";
import { test } from "node:test";

import { DECK_OUTLINE_MAX_CHARS, elisionMarker, fitDeckOutline, type OutlineSlide } from "./deck-outline-budget.ts";

const deck = (pages: number, elements: number): OutlineSlide[] =>
  Array.from({ length: pages }, (_, i) => ({
    header: `Page ${i + 1} (slideIndex=${i}):`,
    lines: [
      `  main fills: #FFFFFF×${elements}`,
      ...Array.from({ length: elements }, (_, k) => `  - sp${i}_${k} | shape | "Element ${k} of page ${i + 1} with some longer preview text"`),
    ],
    summary: `  "Title of page ${i + 1}" · ${elements} elements · fills #FFFFFF×${elements}`,
  }));

const chars = (lines: string[]) => lines.reduce((n, l) => n + l.length + 1, 0);

test("a small deck is emitted unchanged (pass 1)", () => {
  const slides = deck(8, 10);
  const r = fitDeckOutline(slides, { current: 3 });
  assert.equal(r.pass, 1);
  assert.equal(r.compacted, 0);
  assert.equal(r.elided, 0);
  assert.deepEqual(r.lines, slides.flatMap((s) => [s.header, ...s.lines]));
});

test("a large deck compacts non-focus pages to one line and keeps the focus window in full (pass 2)", () => {
  const slides = deck(40, 12); // ~40k chars in full
  const r = fitDeckOutline(slides, { current: 20, maxChars: DECK_OUTLINE_MAX_CHARS });
  assert.equal(r.pass, 2);
  assert.ok(chars(r.lines) <= DECK_OUTLINE_MAX_CHARS);
  // focus: 18..22 plus first and last -> 7 full pages, 33 compact
  assert.equal(r.compacted, 33);
  assert.equal(r.elided, 0);
  for (const i of [18, 19, 20, 21, 22, 0, 39]) {
    assert.ok(r.lines.includes(slides[i]!.header), `header ${i}`);
    assert.ok(r.lines.includes(slides[i]!.lines[1]!), `full element line for page ${i}`);
  }
  assert.ok(r.lines.includes(slides[10]!.summary));
  assert.ok(!r.lines.includes(slides[10]!.lines[1]!), "compact page carries no element lines");
  // every page header is still present: numbering stays verifiable
  for (const s of slides) assert.ok(r.lines.includes(s.header));
});

test("a very large deck elides the farthest pages behind a marker and never touches the focus (pass 3)", () => {
  const slides = deck(120, 15);
  const r = fitDeckOutline(slides, { current: 60, maxChars: 12_000 });
  assert.equal(r.pass, 3);
  assert.ok(chars(r.lines) <= 12_000, `fits: ${chars(r.lines)}`);
  assert.ok(r.elided > 0);
  // the floor: focus pages are never compacted even when they alone exceed the budget
  const floor = fitDeckOutline(slides, { current: 60, maxChars: 2_000 });
  assert.equal(floor.pass, 3);
  for (const i of [58, 59, 60, 61, 62, 0, 119]) assert.ok(floor.lines.includes(slides[i]!.lines[1]!), `focus page ${i} still in full`);
  assert.equal(floor.elided, 120 - 7);
  for (const i of [58, 59, 60, 61, 62]) assert.ok(r.lines.includes(slides[i]!.lines[1]!), `focus page ${i} in full`);
  assert.ok(r.lines.some((l) => /pages not shown: pages \d+–\d+, slideIndex \d+–\d+; read_slide/.test(l)));
  // pages adjacent to the focus survive longer than distant ones
  const shown = new Set(slides.filter((s) => r.lines.includes(s.header)).map((s) => s.header));
  assert.ok(shown.has(slides[57]!.header) || r.elided >= 100, "nearest pages are the last to go");
});

test("pinned pages (selection elsewhere) and the ends are part of the focus", () => {
  const slides = deck(30, 12);
  const r = fitDeckOutline(slides, { current: 2, pinned: [25], maxChars: 12_000 });
  assert.ok(r.pass >= 2);
  assert.ok(r.lines.includes(slides[25]!.lines[1]!), "pinned page kept in full");
  assert.ok(r.lines.includes(slides[29]!.lines[1]!), "last page kept in full");
  assert.ok(r.lines.includes(slides[0]!.lines[1]!), "first page kept in full");
});

test("elision markers name the hidden index range so the model can read_slide precisely", () => {
  assert.match(elisionMarker(4, 4), /page 5 \(slideIndex=4\)/);
  assert.match(elisionMarker(4, 9), /6 pages not shown: pages 5–10, slideIndex 4–9/);
});

test("empty deck and out-of-range current index are safe", () => {
  assert.deepEqual(fitDeckOutline([], { current: 0 }).lines, []);
  const r = fitDeckOutline(deck(3, 2), { current: 99 });
  assert.equal(r.pass, 1);
});
