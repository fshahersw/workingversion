import "./voice.harness";
import React from "react";
import { createRoot } from "react-dom/client";
import { AgentLoop } from "../../src/writer/packages/agent-core/src/loop";
import type {
  AgentStreamCallbacks,
  AgentStreamRequest,
} from "../../src/writer/packages/agent-core/src/types";
import { OfficeTaskControls } from "../../src/office/shared/OfficeTaskControls";

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
export async function verify(kind: string) {
  let callbacks: AgentStreamCallbacks,
    release = () => {},
    contexts = 0,
    done = 0;
  const requests: AgentStreamRequest[] = [],
    writes: string[] = [],
    applied: readonly string[][] = [];
  const loop = new AgentLoop({
    compaction: false,
    maxTurns: kind === "limit" ? 1 : 10,
    transport: {
      stream: (r, cb) => {
        requests.push(structuredClone(r));
        callbacks = cb;
        return { cancel: () => cb.onDone() };
      },
    },
    skill: {
      id: "real-loop-test",
      systemPrompt: "test",
      buildContext: () => {
        contexts++;
        return "Task context";
      },
      tools: [{ name: "write", description: "write", inputSchema: {} }],
      executeTool: async (call) => {
        writes.push(call.id);
        if (call.id === "first")
          await new Promise<void>((resolve) => {
            release = resolve;
          });
        return { output: "Edited once", mutated: true, summary: "Edited" };
      },
    },
    events: {
      onDone: () => {
        done++;
      },
      onTurnEnd: (directions) => {
        if (directions?.length) (applied as string[][]).push([...directions]);
      },
    },
  });
  loop.run("Make two edits");
  await tick();
  if (kind === "failure") {
    callbacks!.onError("Authorization failed");
    return { status: loop.taskStatus() };
  }
  if (kind === "queue") {
    const accepted = Array.from({ length: 5 }, (_, i) => loop.steer(`Direction ${i}`).accepted);
    const length = loop.getDirections().length;
    loop.clearDirections();
    return {
      accepted,
      length,
      cleared: loop.getDirections().length,
      long: loop.steer("x".repeat(2001)).accepted,
    };
  }
  if (kind === "no-tools" || kind === "limit") {
    loop.steer("Use the current selection only");
    callbacks!.onDelta("Prior answer");
    callbacks!.onDone();
    await tick();
  } else {
    callbacks!.onToolCall({ id: "first", name: "write", input: {} });
    callbacks!.onToolCall({ id: "second", name: "write", input: {} });
    callbacks!.onDone();
    await tick();
    loop.steer("Stop changing the introduction; focus on the conclusion");
    if (kind === "cancel") loop.cancel();
    if (kind === "reset") loop.reset();
    release();
    await tick();
  }
  const beforeFinal = { busy: loop.busy, done };
  if (requests.length > 1) {
    callbacks!.onDelta("Updated task complete");
    callbacks!.onDone();
    await tick();
  }
  return {
    writes,
    requests,
    contexts,
    applied,
    beforeFinal,
    busy: loop.busy,
    done,
    pending: loop.getDirections().length,
    status: loop.taskStatus(),
  };
}
Object.assign(window, { verifyOfficeConversation: verify });
const uiLoop = new AgentLoop({
  compaction: false,
  transport: { stream: () => ({ cancel() {} }) },
  skill: {
    id: "ui",
    systemPrompt: "test",
    tools: [],
    executeTool: () => ({ output: "", summary: "" }),
  },
});
uiLoop.run("Prepare a memorandum");
createRoot(document.getElementById("root")!).render(
  <OfficeTaskControls
    app="writer"
    document="test-doc"
    mode="write"
    loop={uiLoop}
    busy={true}
    onSend={() => {}}
    onStop={() => uiLoop.cancel()}
  />,
);

declare global {
  interface Window {
    verifyOfficeConversation: typeof verify;
  }
}
