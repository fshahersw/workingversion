import assert from "node:assert/strict";
import { test } from "node:test";

import { splitMarkdownBlocks } from "./markdown-blocks.ts";

test("splits paragraphs at blank lines and collapses repeated blank lines", () => {
  assert.deepEqual(splitMarkdownBlocks("One.\n\nTwo.\n\n\n\nThree."), ["One.", "Two.", "Three."]);
  assert.deepEqual(splitMarkdownBlocks(""), []);
  assert.deepEqual(splitMarkdownBlocks("\n\nOnly."), ["Only."]);
});

test("never splits inside a fenced code block, including an unterminated one mid-stream", () => {
  const md = "Intro.\n\n```mermaid\ntimeline\n\n  2024 : filed\n```\n\nAfter.";
  assert.deepEqual(splitMarkdownBlocks(md), [
    "Intro.",
    "```mermaid\ntimeline\n\n  2024 : filed\n```",
    "After.",
  ]);
  // Streaming: the fence has not closed yet, so everything after it is one block.
  const partial = "Intro.\n\n```python\nx = 1\n\nprint(x)";
  assert.deepEqual(splitMarkdownBlocks(partial), ["Intro.", "```python\nx = 1\n\nprint(x)"]);
});

test("a blank line before an indented continuation does not split the block", () => {
  const md = "1. First item\n\n   continues here\n\n2. Second item";
  assert.deepEqual(splitMarkdownBlocks(md), ["1. First item\n\n   continues here", "2. Second item"]);
});

test("tables and headings stay intact", () => {
  const md = "## Posture\n\n| A | B |\n| - | - |\n| 1 | 2 |\n\nDone.";
  assert.deepEqual(splitMarkdownBlocks(md), ["## Posture", "| A | B |\n| - | - |\n| 1 | 2 |", "Done."]);
});

test("a growing stream only changes the last block", () => {
  const a = splitMarkdownBlocks("One.\n\nTwo is being writ");
  const b = splitMarkdownBlocks("One.\n\nTwo is being written.");
  assert.equal(a[0], b[0]);
  assert.notEqual(a[1], b[1]);
});
