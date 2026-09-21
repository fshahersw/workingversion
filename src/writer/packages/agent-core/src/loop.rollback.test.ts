import assert from "node:assert/strict";
import { test } from "node:test";

import { AgentLoop } from "./loop";
import type { AgentSkill } from "./skill";
import type { AgentStreamCallbacks, AgentStreamRequest, AgentTransport, AgentToolCall } from "./types";

/**
 * The rollback contract every office app builds on: the loop hands the host
 * ONE snapshot (captured right before the run's first mutating tool) as
 * `snapshotBefore`, and a failed run still ends in events.onError so the host
 * can restore that snapshot. A multi-mutation run must therefore roll back
 * to the exact pre-run state from that single capture.
 */

type Turn = { toolCalls?: AgentToolCall[]; text?: string; error?: string };

function scriptedTransport(turns: Turn[]): AgentTransport & { requests: AgentStreamRequest[] } {
  const requests: AgentStreamRequest[] = [];
  return {
    requests,
    stream(request, cb: AgentStreamCallbacks) {
      requests.push(request);
      const turn = turns.shift() ?? { text: "done" };
      queueMicrotask(() => {
        if (turn.error) {
          cb.onError(turn.error);
          return;
        }
        if (turn.text) cb.onDelta(turn.text);
        for (const call of turn.toolCalls ?? []) cb.onToolCall(call);
        cb.onDone();
      });
      return { cancel() {} };
    },
  };
}

function docSkill(state: { text: string }): AgentSkill {
  return {
    id: "doc",
    systemPrompt: "edit the doc",
    tools: [
      { name: "append", description: "append text", inputSchema: { type: "object" } },
      { name: "read", description: "read", inputSchema: { type: "object" }, readOnly: true } as never,
    ],
    executeTool(call) {
      if (call.name === "append") {
        state.text += String(call.input["text"] ?? "");
        return { output: "ok", mutated: true, summary: "append" };
      }
      return { output: state.text, summary: "read" };
    },
  };
}

const settle = () => new Promise((r) => setTimeout(r, 20));

test("a multi-mutation run: one snapshot, taken before the first mutation, restores the exact pre-run state", async () => {
  const state = { text: "original" };
  let captures = 0;
  const snapshots: string[] = [];
  const done = new Promise<void>((resolve) => {
    const loop = new AgentLoop<string>({
      transport: scriptedTransport([
        { toolCalls: [{ id: "1", name: "read", input: {} }] },
        {
          toolCalls: [
            { id: "2", name: "append", input: { text: " +a" } },
            { id: "3", name: "append", input: { text: " +b" } },
          ],
        },
        { toolCalls: [{ id: "4", name: "append", input: { text: " +c" } }] },
        { text: "finished" },
      ]),
      skill: docSkill(state),
      compaction: false,
      captureSnapshot: () => {
        captures += 1;
        return state.text;
      },
      events: {
        onToolExecuted: ({ snapshotBefore }) => {
          if (snapshotBefore !== undefined) snapshots.push(snapshotBefore);
        },
        onDone: () => resolve(),
        onError: (e) => {
          throw new Error(`unexpected error: ${e}`);
        },
      },
    });
    loop.run("edit");
  });
  await done;
  assert.equal(state.text, "original +a +b +c", "all three mutations applied");
  // One capture per tool batch until the first mutation lands (the read-only
  // batch keeps a guard capture in case a tool is mis-flagged), none after.
  assert.equal(captures, 2, "captures stop once a mutation has been seen (three mutating calls, two captures)");
  assert.deepEqual(snapshots, ["original"], "snapshotBefore rides on the first mutating tool only");
  // the host's one-click rollback: restore from that single snapshot
  state.text = snapshots[0]!;
  assert.equal(state.text, "original");
});

test("a run that fails after mutating still reaches onError with the pre-run snapshot available to the host", async () => {
  const state = { text: "original" };
  let snapshot: string | undefined;
  let error: string | null = null;
  const done = new Promise<void>((resolve) => {
    const loop = new AgentLoop<string>({
      transport: scriptedTransport([
        { toolCalls: [{ id: "1", name: "append", input: { text: " +partial" } }] },
        { error: "model unavailable" },
      ]),
      skill: docSkill(state),
      compaction: false,
      captureSnapshot: () => state.text,
      events: {
        onToolExecuted: ({ snapshotBefore }) => {
          if (snapshotBefore !== undefined) snapshot = snapshotBefore;
        },
        onError: (e) => {
          error = e;
          // what Writer / Sheets / Slides now do in their onError: revert the partial run
          if (snapshot !== undefined) state.text = snapshot;
          resolve();
        },
        onDone: () => resolve(),
      },
    });
    loop.run("edit");
  });
  await done;
  await settle();
  assert.ok(error, "the failure surfaced");
  assert.equal(state.text, "original", "the partial mutation was reverted from the pre-run snapshot");
});
