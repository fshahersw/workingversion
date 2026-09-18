import assert from "node:assert/strict";
import { test } from "node:test";

import { DelimitedError, parseDelimited, sniffDelimiter, typeCell } from "./delimited.ts";

test("typeCell keeps identifiers as text and types numbers/booleans", () => {
  assert.equal(typeCell("007"), "007");
  assert.equal(typeCell("000123"), "000123");
  assert.equal(typeCell("0"), 0);
  assert.equal(typeCell("-3"), -3);
  assert.equal(typeCell("1,200.50"), 1200.5);
  assert.equal(typeCell("4.5e3"), 4500);
  assert.equal(typeCell(".5"), 0.5);
  assert.equal(typeCell("TRUE"), true);
  assert.equal(typeCell("  "), null);
  assert.equal(typeCell("12345678901234567890"), "12345678901234567890");
  assert.equal(typeCell("PLTF000001"), "PLTF000001");
  assert.equal(typeCell("2026-01-05"), "2026-01-05");
});

test("RFC 4180 quoting, embedded newlines and doubled quotes, CRLF and BOM", () => {
  const text = '\uFEFFBates,Description,Amount\r\n"PLTF000001","Memo re ""safety"" review,\nsecond line",1200\r\nPLTF000002,,\r\n';
  const t = parseDelimited(text);
  assert.equal(t.delimiter, ",");
  assert.equal(t.columns, 3);
  assert.deepEqual(t.rows[0], ["Bates", "Description", "Amount"]);
  assert.deepEqual(t.rows[1], ["PLTF000001", 'Memo re "safety" review,\nsecond line', 1200]);
  assert.deepEqual(t.rows[2], ["PLTF000002", null, null]);
  assert.equal(t.rows.length, 3);
});

test("delimiter sniffing and ragged-row padding", () => {
  assert.equal(sniffDelimiter("a\tb\tc\n1\t2\t3"), "\t");
  assert.equal(sniffDelimiter("a;b;c\n1;2;3"), ";");
  assert.equal(sniffDelimiter("a|b\n1|2"), "|");
  const t = parseDelimited("a;b;c\n1;2\n3;4;5", { delimiter: "auto" });
  assert.equal(t.delimiter, ";");
  assert.deepEqual(t.rows[1], [1, 2, null]);
  assert.equal(t.warnings.length, 1);
});

test("asText disables inference; empty input and cap are errors", () => {
  const t = parseDelimited("id,n\n007,12", { asText: true });
  assert.deepEqual(t.rows[1], ["007", "12"]);
  assert.throws(() => parseDelimited("   \n"), DelimitedError);
  assert.throws(() => parseDelimited('a,"b\n1,2'), /unbalanced quote/);
  const big = Array.from({ length: 11 }, (_, i) => `${i},${i},${i}`).join("\n");
  assert.throws(() => parseDelimited(big, { maxCells: 30 }), /above the 30-cell import limit/);
});
