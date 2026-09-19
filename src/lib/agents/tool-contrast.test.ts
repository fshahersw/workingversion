import assert from "node:assert/strict";
import { test } from "node:test";

import { RESEARCH_TOOLS } from "./research-tools.server.ts";
import {
  PLATFORM_TOOL_CONTRAST,
  RESEARCH_TOOL_CONTRAST,
  SHEETS_TOOL_CONTRAST,
  SLIDES_TOOL_CONTRAST,
  WRITER_TOOL_CONTRAST,
  contrastText,
  withToolContrast,
} from "./tool-contrast.ts";

test("withToolContrast appends one block per tool, leaves unknown tools alone, and is idempotent", () => {
  const tools = [
    { name: "a", description: "Does A." },
    { name: "b", description: "Does B.\n" },
    { name: "zzz", description: "Unknown." },
  ];
  const out = withToolContrast(tools, { a: { use: "x", notFor: "y", examples: ["e1", "e2"] }, b: { use: "p", notFor: "q" } });
  assert.equal(out[0]!.description, 'Does A.\nUse for: x. Not for: y. Examples: "e1"; "e2".');
  assert.equal(out[1]!.description, "Does B.\nUse for: p. Not for: q.");
  assert.equal(out[2]!.description, "Unknown.");
  const again = withToolContrast(out, { a: { use: "x", notFor: "y" } });
  assert.equal(again[0]!.description, out[0]!.description, "no double append");
  assert.equal(contrastText({ use: "u", notFor: "n" }), "\nUse for: u. Not for: n.");
});

test("every contrast entry has substantive content", () => {
  for (const [surface, map] of Object.entries({ WRITER_TOOL_CONTRAST, SHEETS_TOOL_CONTRAST, SLIDES_TOOL_CONTRAST, RESEARCH_TOOL_CONTRAST, PLATFORM_TOOL_CONTRAST })) {
    for (const [name, c] of Object.entries(map)) {
      assert.match(name, /^[a-z][a-z0-9_]+$/, `${surface}.${name}`);
      assert.ok(c.use.length >= 12 && c.notFor.length >= 8, `${surface}.${name} is too thin`);
      assert.ok(!/\.$/.test(c.use) && !/\.$/.test(c.notFor), `${surface}.${name}: no trailing period (the renderer adds it)`);
    }
  }
});

test("the research tool list carries a contrast block on every tool and verify_citations leads with the rule", () => {
  const names = RESEARCH_TOOLS.map((t) => t.name);
  for (const key of Object.keys(RESEARCH_TOOL_CONTRAST)) assert.ok(names.includes(key), `contrast for unknown research tool ${key}`);
  for (const t of RESEARCH_TOOLS) {
    assert.ok(t.description.includes("\nUse for: "), `${t.name} lacks a contrast block`);
    assert.ok(t.description.includes(" Not for: "), `${t.name} lacks a not-for line`);
  }
  const verify = RESEARCH_TOOLS.find((t) => t.name === "verify_citations")!;
  assert.match(verify.description, /^Call before finalizing ANY legal citation/);
});
