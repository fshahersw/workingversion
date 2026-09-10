import assert from "node:assert/strict";
import { test } from "node:test";

import type {
  EvidenceItem,
  OrchestratorDecision,
  RequestContext,
  ToolCallSpec,
  ToolRunResult,
} from "./frontier-contracts.ts";
import { normalizeRoutePlan } from "./frontier-router.ts";
import { ResearchState } from "./frontier-research-state.ts";
import {
  ChoiceRequired,
  parallelExecute,
  researchLoop,
  type Orchestrator,
  type ToolRunner,
} from "./frontier-research-loop.server.ts";

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

function ctx(): RequestContext {
  return {
    requestId: "r1",
    conversationId: "c1",
    userMessage: "test",
    currentDateIso: "2026-09-10",
    recentMessages: [],
  };
}

function state(rounds: number, requirements: never[] = []): ResearchState {
  return new ResearchState(
    ctx(),
    normalizeRoutePlan({ complexity: "standard", needsTools: true, maxResearchRounds: rounds }),
    requirements,
  );
}

function ev(id: string, supports: string[] = []): EvidenceItem {
  return {
    id,
    sourceType: "court_opinion",
    provider: "courtlistener",
    authorityLevel: 1,
    title: id,
    url: `https://court.gov/${id}`,
    retrievedAt: "2026-09-10T00:00:00Z",
    supports,
    contradicts: [],
    primarySource: true,
    currentVerified: true,
    confidence: 0.9,
  };
}

/** Orchestrator that returns a fixed script of decisions, then complete. */
class ScriptedOrchestrator implements Orchestrator {
  calls = 0;
  private readonly script: OrchestratorDecision[];
  constructor(script: OrchestratorDecision[]) {
    this.script = script;
  }
  decide(): Promise<OrchestratorDecision> {
    const d = this.script[this.calls] ?? { status: "complete" as const };
    this.calls++;
    return Promise.resolve(d);
  }
}

/** Runner that records how many times it actually executed, keyed by args. */
class RecordingRunner implements ToolRunner {
  runs: string[] = [];
  run(call: ToolCallSpec): Promise<ToolRunResult> {
    this.runs.push(JSON.stringify(call.args));
    return Promise.resolve({
      callId: call.id,
      tool: call.tool,
      ok: true,
      evidence: [ev(`${call.id}-src`)],
    });
  }
}

function batch(calls: ToolCallSpec[]): OrchestratorDecision {
  return { status: "tool_batch", calls };
}

test("researchLoop runs a batch then stops on complete", async () => {
  const s = state(3);
  const orch = new ScriptedOrchestrator([
    batch([{ id: "a", tool: "web.search", args: { q: "1" } }]),
    { status: "complete" },
  ]);
  const runner = new RecordingRunner();
  const bundle = await researchLoop(s, orch, runner);
  assert.equal(orch.calls, 2); // decided twice: batch, then complete
  assert.equal(runner.runs.length, 1);
  assert.equal(bundle.items.length, 1);
});

test("researchLoop respects the hard round ceiling", async () => {
  const s = state(2);
  // Always asks for more work — the loop must still stop at maxResearchRounds=2.
  const orch = new ScriptedOrchestrator([
    batch([{ id: "a", tool: "web.search", args: { q: "1" } }]),
    batch([{ id: "b", tool: "web.search", args: { q: "2" } }]),
    batch([{ id: "c", tool: "web.search", args: { q: "3" } }]),
  ]);
  const runner = new RecordingRunner();
  await researchLoop(s, orch, runner);
  assert.equal(orch.calls, 2);
  assert.equal(runner.runs.length, 2);
});

test("researchLoop stops early when required coverage is met", async () => {
  const s = state(4, [{ id: "need", description: "need", required: true, evidenceIds: [], status: "missing" }] as never);
  const orch = new ScriptedOrchestrator([
    batch([{ id: "a", tool: "courtlistener.search", args: { q: "1" } }]),
    batch([{ id: "b", tool: "web.search", args: { q: "2" } }]),
  ]);
  // Runner returns evidence that supports the requirement, so after round 1 it is verified.
  const runner: ToolRunner = {
    run: (call) =>
      Promise.resolve({ callId: call.id, tool: call.tool, ok: true, evidence: [ev(`${call.id}-src`, ["need"])] }),
  };
  await researchLoop(s, orch, runner);
  assert.equal(orch.calls, 1); // stopped after the first round's coverage check
});

test("researchLoop throws ChoiceRequired with the panel", async () => {
  const s = state(2);
  const panel = { id: "p", title: "Which?", selectionMode: "single" as const, options: [] };
  const orch = new ScriptedOrchestrator([{ status: "request_user_choice", choicePanel: panel }]);
  await assert.rejects(() => researchLoop(s, orch, new RecordingRunner()), (e: unknown) => {
    assert.ok(e instanceof ChoiceRequired);
    assert.equal(e.panel.id, "p");
    return true;
  });
});

test("parallelExecute dedupes identical calls (runs once, both results returned)", async () => {
  const runner = new RecordingRunner();
  const calls: ToolCallSpec[] = [
    { id: "a", tool: "web.search", args: { q: "same" } },
    { id: "b", tool: "web.search", args: { q: "same" } },
  ];
  const results = await parallelExecute(runner, calls);
  assert.equal(runner.runs.length, 1); // executed once
  assert.equal(results.length, 2);
  assert.deepEqual(results.map((r) => r.callId).sort(), ["a", "b"]); // both callIds preserved
});

test("parallelExecute enforces max concurrency", async () => {
  let active = 0;
  let peak = 0;
  const runner: ToolRunner = {
    run: async (call) => {
      active++;
      peak = Math.max(peak, active);
      await delay(15);
      active--;
      return { callId: call.id, tool: call.tool, ok: true, evidence: [] };
    },
  };
  const calls: ToolCallSpec[] = Array.from({ length: 6 }, (_, i) => ({
    id: `c${i}`,
    tool: "web.search",
    args: { i },
  }));
  await parallelExecute(runner, calls, { maxConcurrency: 2 });
  assert.ok(peak <= 2, `peak concurrency ${peak} should be <= 2`);
});

test("parallelExecute times out a hung call as ok:false", async () => {
  const runner: ToolRunner = {
    run: () => new Promise<ToolRunResult>(() => {}), // never resolves
  };
  const results = await parallelExecute(runner, [{ id: "a", tool: "web.search", args: {} }], {
    perCallTimeoutMs: 20,
  });
  assert.equal(results[0]!.ok, false);
  assert.match(results[0]!.error ?? "", /timeout/);
});
