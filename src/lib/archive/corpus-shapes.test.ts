import assert from "node:assert/strict";
import { test } from "node:test";

import {
  countBasis,
  normalizeStateCode,
  rowsAt,
  stateCoverageValues,
  stateSelection,
} from "./corpus-shapes.ts";

test("state names and USPS codes normalize without inventing jurisdictions", () => {
  assert.equal(normalizeStateCode("NJ"), "NJ");
  assert.equal(normalizeStateCode("New Jersey"), "NJ");
  assert.deepEqual(stateSelection("District of Columbia"), {
    code: "DC",
    name: "District of Columbia",
  });
  assert.equal(normalizeStateCode("Federal"), null);
  assert.equal(normalizeStateCode(""), null);
});

test("map values come from the live explore jurisdictions envelope", () => {
  const payload = {
    count_basis:
      "Distinct local display groups plus separate publisher records; state facets may overlap.",
    jurisdictions: [
      {
        state: "Alabama",
        label: "Alabama",
        bulk_records: 47_442,
        local_documents: 46,
        total: 47_488,
      },
      {
        state: "New Jersey",
        label: "New Jersey",
        bulk_records: 64_000,
        local_documents: 91,
        total: 64_091,
      },
    ],
  };

  assert.deepEqual(stateCoverageValues(payload), [
    { code: "AL", name: "Alabama", total: 47_488 },
    { code: "NJ", name: "New Jersey", total: 64_091 },
  ]);
  assert.match(countBasis(payload) ?? "", /Distinct local display groups/);
});

test("map parser tolerates missing and malformed rows", () => {
  assert.deepEqual(
    stateCoverageValues({
      jurisdictions: [
        { state: "NJ", total: "12" },
        { state: "New Jersey", total: 8 },
        { state: "Federal", total: 100 },
        { state: "TX", total: "not-a-number" },
      ],
    }),
    [{ code: "NJ", name: "New Jersey", total: 12 }],
  );
  assert.deepEqual(stateCoverageValues({ available: false }), []);
});

test("known list envelopes expose rows and unknown shapes fall back cleanly", () => {
  assert.deepEqual(rowsAt({ results: [{ id: "mdl:2738" }] }, "results", "items"), [
    { id: "mdl:2738" },
  ]);
  assert.deepEqual(rowsAt({ items: [] }, "results", "items"), []);
  assert.deepEqual(rowsAt({ unexpected: true }, "results", "items"), []);
});
