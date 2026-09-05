// Unit test for the run-trace collector. Feeds a realistic agentLog event
// sequence through recordTrace() and asserts the reconstructed summary +
// timeline. Deterministic: no AWS, no network, no auth.
//   node --experimental-strip-types --test src/lib/agents/trace.server.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { recordTrace, getRunSummaries, getRunTrace, traceEnabled } from "./trace.server.ts";

test("collector is enabled outside production", () => {
  assert.equal(traceEnabled(), true);
});

test("reconstructs a completed think run from agentLog events", () => {
  const run = `test-run-${Math.random().toString(36).slice(2)}`;
  recordTrace("run_start", { run, engine: "single_agent", mode: "think", q: "How do Lone Pine orders work?" }, "log");
  recordTrace("agent_step", { run, step: 1, ms: 3200, stop: "tool_use", in: 14814, out: 220, cache_read: 0, cache_write: 14814, calls: "search_authorities" }, "log");
  recordTrace("agent_step", { run, step: 2, ms: 4100, stop: "end_turn", in: 2100, out: 1800, cache_read: 14814, cache_write: 2100, calls: "-" }, "log");
  recordTrace("coverage_check", { run, consulted: true, covered: false, missing: 2, sources: 16 }, "log");
  recordTrace("research_loop", { run, ms: 60000, mode: "think", steps: 4, tool_calls: 5, hits: 22, sources: 22, answer_chars: 6000, gate_requeried: true, tokens_in: 61000, tokens_out: 4200, tokens_total: 65200, cache_read: 90000, cache_write: 20000 }, "log");
  recordTrace("verification", { run, mode: "think", facts_checked: 5, facts_verified: 3, orphan_refs: 0, faith_checked: 15, faith_supported: 11, faith_unsupported: 4 }, "log");
  recordTrace("run_done", { run, status: "complete", mode: "think", sources: 22, answer_chars: 6000, total_ms: 62000, tokens_in: 61000, tokens_out: 4200, tokens_total: 65200 }, "log");

  const trace = getRunTrace(run);
  assert.ok(trace, "trace should exist");
  assert.equal(trace!.events.length, 7);
  // `run` is stripped from stored fields; relative `at` is present.
  assert.equal((trace!.events[0].fields as Record<string, unknown>)["run"], undefined);
  assert.ok(typeof trace!.events[0].at === "number");

  const summary = getRunSummaries().find((s) => s.run === run);
  assert.ok(summary, "summary should exist");
  assert.equal(summary!.status, "complete");
  assert.equal(summary!.mode, "think");
  assert.equal(summary!.query, "How do Lone Pine orders work?");
  assert.equal(summary!.steps, 4);
  assert.equal(summary!.toolCalls, 5);
  assert.equal(summary!.sources, 22);
  assert.equal(summary!.totalMs, 62000);
  assert.equal(summary!.gateRequeried, true);
  assert.deepEqual(summary!.faith, { checked: 15, supported: 11, unsupported: 4 });
  assert.deepEqual(summary!.verify, { checked: 5, verified: 3 });
  assert.deepEqual(summary!.tokens, { in: 61000, out: 4200, total: 65200 });
});

test("a failed run is marked error with its message", () => {
  const run = `test-fail-${Math.random().toString(36).slice(2)}`;
  recordTrace("run_start", { run, engine: "single_agent", mode: "think", q: "x" }, "log");
  recordTrace("no_answer", { run, q: "x" }, "error");
  recordTrace("run_failed", { run, total_ms: 10811, error: "Research produced no answer (Bedrock unavailable or throttled)." }, "error");

  const summary = getRunSummaries().find((s) => s.run === run);
  assert.ok(summary);
  assert.equal(summary!.status, "error");
  assert.match(summary!.error ?? "", /no answer/);
});

test("run-less events are ignored (not attributable to a timeline)", () => {
  const before = getRunSummaries().length;
  recordTrace("faithfulness", { model: "nvidia.nemotron-nano-3-30b", ms: 1400, claims: 15, evaluated: 15 }, "log");
  assert.equal(getRunSummaries().length, before);
});

test("summaries are most-recent-first", () => {
  const a = `test-order-a-${Math.random().toString(36).slice(2)}`;
  const b = `test-order-b-${Math.random().toString(36).slice(2)}`;
  recordTrace("run_start", { run: a, mode: "fast", q: "a" }, "log");
  recordTrace("run_start", { run: b, mode: "fast", q: "b" }, "log");
  const summaries = getRunSummaries();
  const ia = summaries.findIndex((s) => s.run === a);
  const ib = summaries.findIndex((s) => s.run === b);
  assert.ok(ib < ia, "b (newer) should come before a (older)");
});
