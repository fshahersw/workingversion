import assert from "node:assert/strict";
import { test } from "node:test";

import { cellClassFor, classifyCell } from "./markdown-table-cells.ts";

test("atomic values never wrap: dates, amounts, docket and Bates numbers, short codes", () => {
  for (const v of ["2022-10-06", "10/6/2022", "Oct. 6, 2022", "$1,200,000.50", "12.5%", "1:23-cv-04567", "MDL 2738", "No. 21-1234", "ACME-0001234", "Pending", "Granted in part", "—", "n/a"]) {
    assert.equal(classifyCell(v, false), "atomic", v);
    assert.match(cellClassFor(v, false), /whitespace-nowrap/);
  }
});

test("prose cells get a floor and a ceiling; short text gets a floor only", () => {
  const long = "The court denied the motion to exclude the plaintiffs' general causation expert, holding that the methodology satisfied Rule 702.";
  assert.equal(classifyCell(long, false), "prose");
  assert.equal(cellClassFor(long, false), "min-w-[14rem] max-w-[34rem]");
  assert.equal(classifyCell("Denied without prejudice to renewal", false), "short");
  assert.equal(cellClassFor("Denied without prejudice to renewal", false), "min-w-[8rem]");
});

test("headers: short headers stay on one line, long headers get a floor", () => {
  assert.match(cellClassFor("Date", true), /whitespace-nowrap/);
  assert.match(cellClassFor("Ruling on motion", true), /whitespace-nowrap/);
  assert.equal(cellClassFor("Additional Participants Copied", true), "whitespace-nowrap");
  assert.equal(cellClassFor("Additional participants copied on the communication", true), "min-w-[9rem]");
});
