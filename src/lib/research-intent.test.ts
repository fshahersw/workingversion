import assert from "node:assert/strict";
import { test } from "node:test";

import { classifyEffort, detectDocRequest } from "./research-intent.ts";

test("social openers and acknowledgements are conversational", () => {
  for (const q of ["thanks, that helps", "hey there", "ok got it", "good morning"]) {
    assert.equal(classifyEffort(q, 1).mode, "conversational", q);
  }
});

test("reformat requests of a prior answer are conversational only with history", () => {
  const reformats = [
    "summarize that in 3 bullets",
    "make it a table",
    "shorten that",
    "key takeaways from the above",
    "say it in plain english",
  ];
  for (const q of reformats) {
    assert.equal(classifyEffort(q, 2).mode, "conversational", q);
    assert.notEqual(classifyEffort(q, 0).mode, "conversational", `${q} (first turn)`);
  }
});

test("a legal signal always blocks the conversational route", () => {
  assert.equal(classifyEffort("thanks, now what did the court hold?", 3).mode, "fast");
  assert.equal(classifyEffort("summarize the settlement allocation", 3).mode, "fast");
});

test("single scoped lookups are fast, multi-part questions are think", () => {
  assert.equal(classifyEffort("Who is the transferee judge in the Zantac MDL?", 0).mode, "fast");
  assert.equal(
    classifyEffort(
      "Compare the Daubert rulings on the epidemiology experts in the talc and Roundup MDLs and assess implications for our causation case",
      0,
    ).mode,
    "think",
  );
  assert.equal(
    classifyEffort("What happened with the recall? And the label change?", 0).mode,
    "think",
  );
});

test("ambiguous questions default to full tools", () => {
  assert.equal(classifyEffort("What should we do about the new filings", 0).mode, "think");
});

test("document requests are detected with format and page count", () => {
  const pdf = detectDocRequest("Prepare a 5 page PDF memo on the bellwether schedule");
  assert.equal(pdf.wants, true);
  assert.equal(pdf.format, "pdf");
  assert.equal(pdf.pages, 5);
  const xlsx = detectDocRequest("Put the recall history in a spreadsheet");
  assert.equal(xlsx.wants, true);
  assert.equal(xlsx.format, "xlsx");
  assert.equal(detectDocRequest("What is the status of the MDL?").wants, false);
});
