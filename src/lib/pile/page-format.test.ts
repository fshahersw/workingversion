import assert from "node:assert/strict";
import { test } from "node:test";

import { formatRetrievedPage } from "./page-format.ts";

test("formatRetrievedPage keeps paragraphs and joins hyphenated line breaks", () => {
  const raw = "The defend-\nant moved.\n\n\nORDER\n\nGranted.   \n";
  assert.equal(formatRetrievedPage(raw), "The defendant moved.\n\nORDER\n\nGranted.");
});
