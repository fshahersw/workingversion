import assert from "node:assert/strict";
import { test } from "node:test";

import { QueryError, compareScalars, matchableText, numericValue, runQuery, type QueryInput } from "./query-range.ts";

const log: QueryInput = {
  columns: ["A", "B", "C", "D", "E"],
  rows: [
    ["Bates", "Custodian", "Date", "Status", "Amount"],
    ["PLTF000001", "Smith", "2026-01-05", "Produced", "$1,200"],
    ["PLTF000002", "Jones", "2026-01-09", "Withheld", 350],
    ["PLTF000003", "smith", "2025-12-30", "Withheld", "2,000"],
    ["PLTF000004", "Lee", "2026-02-01", "Redacted", null],
    [null, null, null, null, null],
    ["PLTF000005", "Jones", "2026-01-20", "Produced", 75.5],
  ],
};

test("value typing: numeric text, currency, percent, dates and matchable keys", () => {
  assert.equal(numericValue("$1,200"), 1200);
  assert.equal(numericValue("12%"), 0.12);
  assert.equal(numericValue("PLTF000001"), null);
  assert.equal(numericValue("2026-01-05"), null);
  assert.equal(matchableText(" Smith "), "smith");
  assert.equal(matchableText("1,200"), matchableText(1200));
  assert.ok(compareScalars("2025-12-30", "2026-01-05") < 0);
  assert.ok(compareScalars("$2,000", 350) > 0);
  assert.ok(compareScalars(null, "a") > 0, "blanks sort last");
});

test("filter by header name with AND/OR, blank rows never match", () => {
  const r = runQuery(log, {
    where: { all: [{ column: "Status", op: "eq", value: "withheld" }] },
  });
  assert.equal(r.total, 6);
  assert.equal(r.matched, 2);
  assert.deepEqual(r.header, ["Bates", "Custodian", "Date", "Status", "Amount"]);
  assert.deepEqual(
    r.rows.map((row) => row[0]),
    ["PLTF000002", "PLTF000003"],
  );
  const any = runQuery(log, {
    where: { any: [{ column: "Custodian", op: "eq", value: "Lee" }, { column: "E", op: "gt", value: 1000 }] },
  });
  assert.deepEqual(
    any.rows.map((row) => row[0]).sort(),
    ["PLTF000001", "PLTF000003", "PLTF000004"],
  );
});

test("numeric and date comparisons, in/notIn, contains, between, blank", () => {
  const big = runQuery(log, { where: { all: [{ column: "Amount", op: "gte", value: "1,000" }] } });
  assert.deepEqual(big.rows.map((r) => r[0]), ["PLTF000001", "PLTF000003"]);
  const jan = runQuery(log, {
    where: { all: [{ column: "Date", op: "between", value: "2026-01-01", value2: "2026-01-31" }] },
  });
  assert.deepEqual(jan.rows.map((r) => r[0]), ["PLTF000001", "PLTF000002", "PLTF000005"]);
  const notIn = runQuery(log, { where: { all: [{ column: "Status", op: "notIn", values: ["Produced", "Redacted"] }] } });
  assert.equal(notIn.matched, 2);
  const blanks = runQuery(log, { where: { all: [{ column: "Amount", op: "blank" }] } });
  assert.deepEqual(blanks.rows.map((r) => r[0]), ["PLTF000004"]);
  const contains = runQuery(log, { where: { all: [{ column: "Bates", op: "contains", value: "00000" }] } });
  assert.equal(contains.matched, 5);
});

test("multi-key sort with blanks last, projection, distinct, paging", () => {
  const sorted = runQuery(log, {
    orderBy: [
      { column: "Custodian", direction: "asc" },
      { column: "Amount", direction: "desc" },
    ],
    select: ["Custodian", "Amount"],
  });
  assert.deepEqual(sorted.header, ["Custodian", "Amount"]);
  assert.deepEqual(sorted.rows, [
    ["Jones", 350],
    ["Jones", 75.5],
    ["Lee", null],
    ["smith", "2,000"],
    ["Smith", "$1,200"],
  ]);
  const custodians = runQuery(log, { select: ["Custodian"], distinct: true, orderBy: [{ column: "Custodian" }] });
  assert.deepEqual(
    custodians.rows.map((r) => r[0]),
    ["Jones", "Lee", "Smith"],
  );
  const page = runQuery(log, { orderBy: [{ column: "A" }], limit: 2, offset: 2 });
  assert.equal(page.resultRows, 5);
  assert.deepEqual(page.rows.map((r) => r[0]), ["PLTF000003", "PLTF000004"]);
});

test("group by with aggregates, custom labels, and sorting on the aggregate", () => {
  const r = runQuery(log, {
    groupBy: ["Custodian"],
    aggregates: [
      { column: "Amount", fn: "sum", as: "Total" },
      { column: "Bates", fn: "count" },
      { column: "Status", fn: "countDistinct" },
    ],
    orderBy: [{ column: "Total", direction: "desc" }],
  });
  assert.deepEqual(r.header, ["Custodian", "Total", "count(Bates)", "countDistinct(Status)"]);
  assert.deepEqual(r.rows, [
    ["Smith", 3200, 2, 2],
    ["Jones", 425.5, 2, 2],
    ["Lee", null, 1, 1],
  ]);
});

test("errors are specific: unknown column, missing value, groupBy without aggregate", () => {
  assert.throws(() => runQuery(log, { where: { all: [{ column: "Nope", op: "eq", value: 1 }] } }), (e: unknown) => {
    assert.ok(e instanceof QueryError);
    assert.match((e as Error).message, /unknown column "Nope"\. Available: A \(Bates\)/);
    return true;
  });
  assert.throws(() => runQuery(log, { where: { all: [{ column: "A", op: "gt" }] } }), /gt needs value/);
  assert.throws(() => runQuery(log, { groupBy: ["Custodian"] }), /at least one aggregate/);
  assert.throws(() => runQuery(log, { where: { all: [{ column: "A", op: "matches", value: "(" }] } }), /invalid regular expression/);
});

test("headerless blocks address columns by letter and label output by letter", () => {
  const r = runQuery(
    { columns: ["C", "D"], rows: [["x", 1], ["y", 2], ["z", 3]] },
    { hasHeader: false, where: { all: [{ column: "D", op: "gte", value: 2 }] }, writeHeader: true },
  );
  assert.deepEqual(r.header, ["C", "D"]);
  assert.deepEqual(r.rows, [["y", 2], ["z", 3]]);
  assert.equal(runQuery({ columns: ["C"], rows: [["a"]] }, { hasHeader: false, writeHeader: false }).header, null);
});
