import assert from "node:assert/strict";
import { test } from "node:test";

import { applyEvent, emptyAssistant, reduceChatMessages } from "./chat-reducer.ts";
import type { Message } from "./chat-types.ts";

const sse = (id: string, event: string, data: unknown) => ({ type: "sse" as const, id, evt: { event, data } });

const forum = {
  id: "forum",
  prompt: "Which docket should this cover?",
  options: [
    { id: "federal", label: "Federal MDL" },
    { id: "both", label: "Both tracks" },
  ],
};

test("a new question dismisses an open clarification panel; a resume answers it in place", () => {
  let s: Message[] = reduceChatMessages([], { type: "user", id: "u1", text: "Next trial in the Depo-Provera litigation?" });
  s = reduceChatMessages(s, { type: "assistant_start", id: "a1" });
  s = reduceChatMessages(s, sse("a1", "choice", { choice: forum }));
  s = reduceChatMessages(s, sse("a1", "done", { status: "awaiting_choice" }));
  assert.equal(s[1]?.choice?.id, "forum");
  assert.equal(s[1]?.status, "done");
  assert.equal(s[1]?.choice?.dismissed, undefined);

  const resumed = reduceChatMessages(s, {
    type: "choice_resume",
    id: "a1",
    answer: { id: "forum", optionId: "both", label: "Both tracks" },
  });
  assert.equal(resumed[1]?.status, "thinking");
  assert.equal(resumed[1]?.answer, "");
  assert.equal(resumed[1]?.choice?.answered?.optionId, "both");
  assert.equal(resumed[1]?.choice?.prompt, forum.prompt, "the panel text survives as a receipt");

  const movedOn = reduceChatMessages(s, { type: "user", id: "u2", text: "Something else entirely" });
  assert.equal(movedOn[1]?.choice?.dismissed, true);
  assert.equal(movedOn[1]?.choice?.answered, undefined);
  assert.equal(movedOn[2]?.role, "user");
});

test("late verification after done lands on its own message, not the newer placeholder", () => {
  let s: Message[] = [emptyAssistant("a1")];
  s = reduceChatMessages(s, sse("a1", "verification", { factsChecked: 3, factsVerified: 2, unverified: ["date: 2026"], orphanRefs: [] }));
  s = reduceChatMessages(s, sse("a1", "done", { status: "complete" }));
  s = reduceChatMessages(s, { type: "user", id: "u2", text: "next" });
  s = reduceChatMessages(s, { type: "assistant_start", id: "a2" });
  s = reduceChatMessages(
    s,
    sse("a1", "verification", {
      factsChecked: 3,
      factsVerified: 2,
      unverified: ["date: 2026"],
      orphanRefs: [],
      faithfulness: { checked: 4, supported: 4, unsupported: [] },
    }),
  );
  assert.equal(s[0]?.status, "done");
  assert.equal(s[0]?.verification?.faithfulness?.checked, 4);
  assert.equal(s[0]?.verification?.factsVerified, 2);
  assert.equal(s[2]?.verification, undefined);
  assert.equal(s[2]?.status, "thinking");
});

test("a timeout mark is cleared by the call's real completion; Stop flags the message", () => {
  let m = emptyAssistant("a1");
  m = applyEvent(m, { event: "round", data: { round: 1 } });
  m = applyEvent(m, { event: "tool_call", data: { round: 1, agent: "research", id: "t1", tool: "web_search", query: "q" } });
  m = applyEvent(m, { event: "tool_call", data: { round: 1, agent: "research", id: "t1", tool: "web_search", hits: 0, ms: 10_000, error: "timeout" } });
  const research = () => m.rounds[0]!.agents["research"]!;
  assert.equal(research().tools.length, 1);
  assert.equal(research().tools[0]?.error, "timeout");
  m = applyEvent(m, { event: "tool_call", data: { round: 1, agent: "research", id: "t1", tool: "web_search", hits: 5, ms: 12_000, hosts: ["law360.com"] } });
  assert.equal(research().tools.length, 1);
  assert.equal(research().tools[0]?.error, undefined);
  assert.equal(research().tools[0]?.hits, 5);
  assert.deepEqual(research().tools[0]?.hosts, ["law360.com"]);
  m = applyEvent(m, { event: "done", data: { status: "stopped" } });
  assert.equal(m.status, "done");
  assert.equal(m.stopped, true);
  assert.equal(m.rounds[0]?.done, true);
  const normal = applyEvent(emptyAssistant("a2"), { event: "done", data: { status: "complete" } });
  assert.equal(normal.stopped, undefined);
});

test("thinking lines become timestamped narration and deltas append", () => {
  let s: Message[] = [emptyAssistant("a1")];
  s = reduceChatMessages(s, { type: "thinking", id: "a1", text: "Reading the docket\nChecking recent orders" });
  assert.equal(s[0]?.narration?.length, 2);
  assert.ok((s[0]?.narration?.[0]?.at ?? 0) > 0);
  s = reduceChatMessages(s, { type: "delta_flush", id: "a1", text: "Hello " });
  s = reduceChatMessages(s, { type: "delta_flush", id: "a1", text: "world" });
  assert.equal(s[0]?.answer, "Hello world");
  assert.equal(s[0]?.narration?.length, 2, "delta flushes keep narration");
});
