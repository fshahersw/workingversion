import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  EXCLUDED_TOOLS,
  WORKFLOW_TOOLS,
  approvedToolNames,
  buildToolArgs,
  isApprovedTool,
} from "./tool-contracts.ts";

/** The thirteen tools the adapter approved before contracts existed. */
const PREVIOUSLY_APPROVED = [
  "web_search",
  "db_search_filings",
  "db_get_case",
  "db_docket_sheet",
  "db_find_case",
  "db_calendar",
  "db_read_filing",
  "verify_citations",
  "search_pubmed",
  "sec_search",
  "federal_register_search",
  "ecfr_search",
  "clinicaltrials_search",
];

describe("workflow tool contracts", () => {
  it("still approves every tool that was approved before", () => {
    for (const name of PREVIOUSLY_APPROVED) {
      assert.equal(isApprovedTool(name), true, `${name} must stay approved`);
    }
  });

  it("hands the query tools exactly the arguments they used to receive", () => {
    // Regression guard: the old adapter built { query, term, limit: 10 } for every
    // query-driven tool, and each tool reads whichever of those keys it wants.
    const built = buildToolArgs("web_search", { query: "asbestos verdicts 2026" });
    assert.equal(built.ok, true);
    assert.ok(built.ok);
    assert.deepEqual(built.args, {
      query: "asbestos verdicts 2026",
      term: "asbestos verdicts 2026",
      limit: 10,
    });
  });

  it("rejects a tool that is not approved", () => {
    const built = buildToolArgs("rm_rf", { query: "anything" });
    assert.equal(built.ok, false);
    assert.ok(!built.ok);
    assert.equal(built.status, 400);
    assert.match(built.message, /not approved/i);
  });

  it("keeps the deliberately excluded tools unreachable", () => {
    for (const name of EXCLUDED_TOOLS) {
      assert.equal(isApprovedTool(name), false, `${name} must stay excluded`);
      const built = buildToolArgs(name, { query: "anything" });
      assert.equal(built.ok, false);
    }
  });

  it("reaches db_graph_ask, which reads question rather than query", () => {
    const built = buildToolArgs("db_graph_ask", { query: "Which defendants moved to dismiss?" });
    assert.ok(built.ok);
    assert.deepEqual(built.args, { question: "Which defendants moved to dismiss?" });
  });

  it("requires the docketbird connector for docket tools only", () => {
    assert.equal(WORKFLOW_TOOLS.db_graph_ask?.connection, "docketbird");
    assert.equal(WORKFLOW_TOOLS.db_search_filings?.connection, "docketbird");
    assert.equal(WORKFLOW_TOOLS.web_search?.connection, undefined);
    assert.equal(WORKFLOW_TOOLS.fda_search?.connection, undefined);
  });

  it("accepts fda_search only with its two structured fields", () => {
    const good = buildToolArgs("fda_search", {
      json: { endpoint: "device/event.json", search: "brand_name:earplug" },
    });
    assert.ok(good.ok);
    assert.deepEqual(good.args, {
      endpoint: "device/event.json",
      search: "brand_name:earplug",
    });

    // A plain query cannot be split into endpoint and search, so it is refused
    // rather than guessed at.
    const fromQuery = buildToolArgs("fda_search", { query: "earplug adverse events" });
    assert.ok(!fromQuery.ok);
    assert.match(fromQuery.message, /structured arguments/i);

    // Missing a required field names the field.
    const partial = buildToolArgs("fda_search", { json: { endpoint: "device/event.json" } });
    assert.ok(!partial.ok);
    assert.match(partial.message, /search/i);
  });

  it("rejects non-object structured arguments", () => {
    for (const json of [[1, 2], "text", 7, null]) {
      const built = buildToolArgs("fda_search", { json });
      assert.ok(!built.ok, `${JSON.stringify(json)} must be refused`);
    }
  });

  it("rejects an empty or oversized query", () => {
    assert.ok(!buildToolArgs("web_search", { query: "   " }).ok);
    assert.ok(!buildToolArgs("web_search", { query: "x".repeat(2001) }).ok);
  });

  it("holds verify_citations to the 40,000 character ceiling", () => {
    assert.ok(buildToolArgs("verify_citations", { json: { text: "See 42 U.S.C. 1983." } }).ok);
    assert.ok(!buildToolArgs("verify_citations", { json: { text: "x".repeat(40001) } }).ok);
    // It reads the step's own source text, so there is no query form.
    assert.ok(!buildToolArgs("verify_citations", { query: "some citation" }).ok);
  });

  it("fails when a step supplies no arguments at all", () => {
    const built = buildToolArgs("web_search", {});
    assert.ok(!built.ok);
    assert.match(built.message, /missing its tool arguments/i);
  });

  it("exposes a stable vocabulary for the Builder", () => {
    const names = approvedToolNames();
    assert.equal(names.length, Object.keys(WORKFLOW_TOOLS).length);
    assert.ok(names.length >= PREVIOUSLY_APPROVED.length + 2);
    // Every contract must be usable: a label, and args that reject a bare object.
    for (const name of names) {
      const contract = WORKFLOW_TOOLS[name]!;
      assert.ok(contract.label.length > 0, `${name} needs a label`);
      assert.equal(contract.args.safeParse({}).success, false, `${name} must require arguments`);
    }
  });
});
