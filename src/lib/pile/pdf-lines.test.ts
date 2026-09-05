import assert from "node:assert/strict";
import { test } from "node:test";

import { reconstructReporterLines } from "./pdf-lines.ts";

test("reconstructReporterLines keeps left-gutter line numbers on their own line", () => {
  const text = reconstructReporterLines([
    { x: 18, y: 700, w: 10, h: 11, str: "1" },
    { x: 72, y: 700, w: 18, h: 11, str: "Q." },
    { x: 94, y: 700, w: 120, h: 11, str: "Please state your name." },
    { x: 18, y: 684, w: 10, h: 11, str: "2" },
    { x: 72, y: 684, w: 18, h: 11, str: "A." },
    { x: 94, y: 684, w: 80, h: 11, str: "Jane Smith." },
  ]);
  assert.match(text, /^1\s+Q\. Please state your name\./m);
  assert.match(text, /^2\s+A\. Jane Smith\./m);
});
