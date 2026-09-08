import assert from "node:assert/strict";
import { test } from "node:test";

import type { Source } from "../chat-types.ts";
import {
  CONTENT_MARKER,
  hasPartialMarker,
  materialForDocument,
  nextReferenceNumber,
  referenceLine,
  splitMaterial,
} from "./material.ts";
import { draftStarters } from "./starters.ts";

const src = (ref: string, url?: string): Source =>
  ({
    ref,
    citation: `Source ${ref}`,
    authority: "web",
    source_type: "web",
    content: "",
    ...(url ? { source_url: url } : {}),
  }) as Source;

test("splitMaterial separates the chat note from the document material", () => {
  const r = splitMaterial(`I drafted the opening.\n${CONTENT_MARKER}\n# Memorandum\n\nText.`);
  assert.equal(r.note, "I drafted the opening.");
  assert.equal(r.material, "# Memorandum\n\nText.");
});

test("a reply without the marker is all note", () => {
  const r = splitMaterial("Here is my answer with [S1].");
  assert.equal(r.note, "Here is my answer with [S1].");
  assert.equal(r.material, null);
});

test("an empty material section counts as no material", () => {
  assert.equal(splitMaterial(`Note only.\n${CONTENT_MARKER}\n   `).material, null);
});

test("partial marker detection guards streaming", () => {
  assert.equal(hasPartialMarker("Drafting the intro <<<CON"), true);
  assert.equal(hasPartialMarker("Drafting the intro <<"), false);
  assert.equal(hasPartialMarker(`Done ${CONTENT_MARKER} body`), false);
  assert.equal(hasPartialMarker("No marker here."), false);
});

test("materialForDocument renumbers [S#] markers and appends the sources used", () => {
  const sources = [src("S1", "https://a.example/x"), src("S2"), src("S3", "https://c.example/y")];
  const { markdown, used } = materialForDocument(
    "The court held X [S3]. Later it held Y [S1, S3].",
    sources,
    4,
  );
  assert.match(markdown, /held X \[\[4\]\]\(https:\/\/c\.example\/y\)/);
  assert.match(
    markdown,
    /held Y \[\[5\]\]\(https:\/\/a\.example\/x\)\[\[4\]\]\(https:\/\/c\.example\/y\)/,
  );
  assert.equal(used.length, 2);
  assert.deepEqual(
    used.map((u) => [u.n, u.ref]),
    [
      [4, "S3"],
      [5, "S1"],
    ],
  );
  assert.match(
    markdown,
    /\*\*Sources\*\*\n\n4\. Source S3 — https:\/\/c\.example\/y\n5\. Source S1 — https:\/\/a\.example\/x/,
  );
});

test("an unknown ref becomes a plain number with an honest sources line", () => {
  const { markdown } = materialForDocument("Fact [S9].", [], 1);
  assert.match(markdown, /Fact \[1\]\./);
  assert.match(markdown, /1\. Source S9 \(not in the retrieved record\)/);
});

test("material without refs gets no sources list", () => {
  const { markdown, used } = materialForDocument("Plain paragraph.", [src("S1")]);
  assert.equal(markdown, "Plain paragraph.");
  assert.equal(used.length, 0);
});

test("reference lines read well for URL-only citations and drop non-dates", () => {
  const urlOnly = referenceLine({
    ...src("S1", "https://www.flsd.uscourts.gov/files/20md2924/PTO%2041.pdf"),
    citation: "https://www.flsd.uscourts.gov/files/20md2924/PTO%2041.pdf",
    effective_date: "unknown",
  } as Source);
  assert.equal(
    urlOnly,
    "flsd.uscourts.gov — PTO 41.pdf — https://www.flsd.uscourts.gov/files/20md2924/PTO%2041.pdf",
  );
  const dated = referenceLine({
    ...src("S2", "https://x.example/post"),
    citation: "Zantac Lawsuit Update",
    effective_date: "05:00PM, Monday, May 11 2026, PDT",
  } as Source);
  assert.equal(dated, "Zantac Lawsuit Update (May 11 2026) — https://x.example/post");
});

test("nextReferenceNumber continues the document's own numbering", () => {
  assert.equal(nextReferenceNumber("No refs yet"), 1);
  assert.equal(nextReferenceNumber("See [2] and [7], also [3]."), 8);
});

test("Ask and Review starters are read-only by construction", () => {
  for (const mode of ["ask", "review"] as const) {
    for (const selected of [true, false]) {
      for (const s of draftStarters(mode, selected, false)) {
        assert.match(s.prompt, /Do not (edit|change)/, `${mode}: ${s.label}`);
      }
    }
  }
});

test("Edit starters exist regardless of selection; empty documents get openers", () => {
  assert.ok(draftStarters("edit", true, false).length >= 3);
  assert.ok(draftStarters("write", false, true).some((s) => /memo/i.test(s.label)));
});
