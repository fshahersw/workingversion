import assert from "node:assert/strict";
import { test } from "node:test";

import {
  classifyEffort,
  detectDocRequest,
  mentionsDocFormat,
  stripClarification,
  stripQueryFrame,
} from "./research-intent.ts";

const FRAME =
  "[Seeger Weiss LLP — plaintiffs' mass tort & complex litigation. Research focus: Prioritize primary sources over trade press; state the procedural posture and date of every authority relied on.]\n\n";

test("social openers and acknowledgements are conversational", () => {
  for (const q of ["thanks, that helps", "hey there", "ok got it", "good morning"]) {
    assert.equal(classifyEffort(q, 1).mode, "conversational", q);
  }
});

test("only the firm frame is stripped; the attorney's own bracket survives", () => {
  assert.equal(stripQueryFrame(`${FRAME}hello`), "hello");
  assert.equal(stripQueryFrame("no frame here"), "no frame here");
  // The attorney's own leading bracket is part of the question and carries its
  // most distinctive anchor (it used to be thrown away with the frame).
  assert.equal(stripQueryFrame("[MDL 3080] status"), "[MDL 3080] status");
  assert.equal(stripQueryFrame("[MDL 3080]"), "[MDL 3080]");
  assert.equal(stripQueryFrame("[internal note] what changed?"), "[internal note] what changed?");
});

test("a clarification constraint does not inflate the effort of a simple question", () => {
  const q = "When is the next trial in the Depo-Provera litigation?";
  const constraint =
    "\n\n[Clarification — forum: Cover both the federal MDL and state coordinated proceedings. Distinguish the two tracks' schedules, presiding courts, and next trial settings.]";
  assert.equal(stripClarification(`${q}${constraint}`), q);
  assert.equal(classifyEffort(`${FRAME}${q}`, 0).mode, "fast");
  assert.equal(
    classifyEffort(`${FRAME}${q}${constraint}`, 0).mode,
    "fast",
    "the appended constraint must not push a one-line lookup to think",
  );
  // A plain hyphen and multiple blocks are tolerated.
  assert.equal(stripClarification("q [Clarification - a: b] [Clarification — c: d]"), "q");
});

test("'in Word' is a format; the idiom 'in a word' is not", () => {
  assert.equal(mentionsDocFormat("Draft a memo in Word on the Ozempic MDL"), true);
  assert.equal(detectDocRequest("Draft a memo in Word on the Ozempic MDL").format, "docx");
  assert.equal(mentionsDocFormat("In a word, yes — summarize the ruling"), false);
  // The wider chat-only phrasing now wins over the verb+noun file inference.
  assert.equal(detectDocRequest("Draft a memo on the Zantac MDL rulings, no file needed").wants, false);
  assert.equal(detectDocRequest("Write up the talc status without a document").wants, false);
  assert.equal(detectDocRequest("Draft a memo on the Zantac MDL rulings").wants, true);
});

test("a framed greeting is still conversational (the frame's 'litigation' must not count)", () => {
  for (const q of ["hello", "hi", "thanks!", "good morning"]) {
    const d = classifyEffort(`${FRAME}${q}`, 0);
    assert.equal(d.mode, "conversational", q);
    assert.ok(d.confidence >= 0.9, `${q} confidence ${d.confidence}`);
  }
  // Meta questions about the assistant need a prior turn (nothing to reformat otherwise).
  assert.equal(classifyEffort(`${FRAME}who are you`, 1).mode, "conversational");
});

test("a framed legal question still routes to the tool loop", () => {
  assert.equal(classifyEffort(`${FRAME}Who is the transferee judge in the Zantac MDL?`, 0).mode, "fast");
  assert.equal(
    classifyEffort(`${FRAME}Compare the Daubert rulings in the talc and Roundup MDLs and assess implications`, 0).mode,
    "think",
  );
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
  assert.equal(
    detectDocRequest("Write a report on talc\n\n[Clarification — deliverable: Answer in chat only. Do not generate a downloadable file.]").wants,
    false,
  );
});
