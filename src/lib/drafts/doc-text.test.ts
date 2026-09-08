import assert from "node:assert/strict";
import { test } from "node:test";

import { docToText, paragraphsDoc } from "./doc-text.ts";
import type { JsonValue } from "./types.ts";

test("docToText joins text nodes and separates blocks", () => {
  const doc: JsonValue = {
    type: "doc",
    content: [
      { type: "heading", attrs: { level: 1 }, content: [{ type: "text", text: "Title" }] },
      {
        type: "paragraph",
        content: [
          { type: "text", text: "First " },
          { type: "text", marks: [{ type: "italic" }], text: "emphasis" },
          { type: "hardBreak" },
          { type: "text", text: "second line" },
        ],
      },
      {
        type: "bulletList",
        content: [
          {
            type: "listItem",
            content: [{ type: "paragraph", content: [{ type: "text", text: "one" }] }],
          },
          {
            type: "listItem",
            content: [{ type: "paragraph", content: [{ type: "text", text: "two" }] }],
          },
        ],
      },
    ],
  };
  const text = docToText(doc);
  assert.match(text, /^Title\n/);
  assert.match(text, /First emphasis\nsecond line/);
  assert.match(text, /one\n[\s\S]*two/);
  assert.ok(!/\n{3,}/.test(text), "runs of blank lines are collapsed");
});

test("docToText tolerates empty and malformed input", () => {
  assert.equal(docToText({ type: "doc", content: [{ type: "paragraph" }] }), "");
  assert.equal(docToText(null), "");
  assert.equal(docToText("not a doc"), "");
});

test("paragraphsDoc builds one paragraph per blank-line-separated block", () => {
  const doc = paragraphsDoc("Alpha line\r\n\r\nBeta\n\n\n  Gamma  ") as {
    content: { type: string }[];
  };
  assert.equal(doc.content.length, 3);
  assert.equal(docToText(doc), "Alpha line\nBeta\nGamma");
  const empty = paragraphsDoc("   ") as { content: { type: string }[] };
  assert.equal(empty.content.length, 1);
});
