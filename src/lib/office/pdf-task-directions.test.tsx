import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import ts from "typescript";
import { transform } from "esbuild";
import { AgentLoop } from "../../writer/packages/agent-core/src/loop";
import type { AgentStreamCallbacks } from "../../writer/packages/agent-core/src/types";
import { createPdfTaskDirections } from "../../office/pdf/task-directions";
import { OfficeTaskControls } from "../../office/shared/OfficeTaskControls";
import { OrderedChatAppender } from "./chat-persistence";

function fixture() {
  let callbacks!: AgentStreamCallbacks;
  let started!: () => void;
  const ready = new Promise<void>(resolve => { started = resolve; });
  const messages: Array<{ role: string; text: string }> = [];
  const writes: Promise<unknown>[] = [];
  const appender = new OrderedChatAppender();
  let current = true;
  const agent = new AgentLoop({
    transport: { stream(_request, cb) { callbacks = cb; started(); return { cancel: () => cb.onDone() }; } },
    skill: { id: "pdf-fixture", systemPrompt: "Synthetic", tools: [], executeTool: () => { throw new Error("No tools expected"); } },
    events: { onTurnEnd: updates => controls.applied(updates), onError: () => controls.finish(), onDone: () => controls.finish() },
  });
  const controls = createPdfTaskDirections(agent, {
    isCurrent: () => current,
    append: message => { writes.push(appender.append("pdf-A", async () => { messages.push(message); })); },
  });
  return { agent, controls, messages, ready, get callbacks() { return callbacks; },
    retire() { current = false; }, async flush() { await Promise.all(writes); } };
}

test("PDF queues normalized directions once, acknowledges application once, and retains core limits", async () => {
  const f = fixture(); f.agent.run("Review all pages"); await f.ready;
  assert.equal(f.controls.loop.steer('x'.repeat(2001)).accepted, false);
  assert.equal(f.controls.loop.steer('  ').accepted, false);
  const directions = ["  Check page 2.  ", "Use plain English.", "Keep existing text.", "Cite page numbers."];
  for (const direction of directions) assert.equal(f.controls.loop.steer(direction).accepted, true);
  assert.equal(f.controls.loop.steer("A fifth direction").accepted, false);
  assert.equal(f.controls.loop.getDirections().length, 4);
  f.callbacks.onDone(); // An actual core boundary consumes the queued directions.
  await Promise.resolve();
  f.controls.applied(directions.map(text => text.trim())); // A duplicate notification must not re-persist.
  await f.flush();
  assert.deepEqual(f.messages.filter(message => message.role === "user").map(message => message.text), directions.map(text => text.trim()));
  assert.equal(f.messages.filter(message => message.text.includes("added to the current task")).length, 1);
  assert.equal(f.controls.loop.getDirections().length, 0);
  assert.ok(JSON.stringify(f.agent.messages).includes("Check page 2."));
  f.agent.reset();
});

test("PDF clear and failed pending directions preserve truthful history; retired document controls cannot append", async () => {
  const f = fixture(); f.agent.run("Review all pages"); await f.ready;
  f.controls.loop.steer("Add a note."); f.controls.loop.clearDirections(); f.controls.loop.clearDirections();
  f.controls.loop.steer("Read page 3.");
  f.callbacks.onError("Synthetic permanent failure", { retryable: false });
  f.controls.finish(); // Duplicate host completion is harmless.
  await f.flush();
  assert.equal(f.messages.filter(message => message.text.startsWith("The user removed")).length, 1);
  assert.equal(f.messages.filter(message => message.text.startsWith("The task ended before")).length, 1);
  assert.match(f.agent.failureCheckpoint!, /Pending user directions[\s\S]*Read page 3/);
  const count = f.messages.length;
  f.retire();
  assert.equal(f.controls.loop.steer("Wrong document").accepted, false);
  f.controls.loop.clearDirections(); f.controls.applied(["Read page 3."]); f.controls.finish();
  await f.flush();
  assert.equal(f.messages.length, count);
});

test("PDF shared controls expose queue and stop without offering unsupported voice", () => {
  const f = fixture();
  const html = renderToStaticMarkup(<OfficeTaskControls app="pdf" document="pdf-A" mode="write" loop={f.controls.loop} busy allowVoice={false} onSend={() => undefined} onStop={() => undefined} stopTitle="Restore PDF changes when possible" />);
  assert.match(html, /Update the running task/);
  assert.match(html, /Queue direction/);
  assert.match(html, /Stop task/);
  assert.doesNotMatch(html, />Voice<|Start a live voice|earlier edits remain/);
});

test("PDF actual busy composer sends through the same queue without starting another run or losing rejected text", async () => {
  const source = await readFile(new URL("../../office/pdf/PdfWorkspace.tsx", import.meta.url), "utf8");
  const tree = ts.createSourceFile("PdfWorkspace.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let expression: ts.Expression | undefined;
  function visit(node: ts.Node) {
    if (ts.isVariableDeclaration(node) && node.name.getText(tree) === "send") expression = node.initializer;
    ts.forEachChild(node, visit);
  }
  visit(tree); assert.ok(expression);
  const code = (await transform(`const send = ${expression.getText(tree)};`, { loader: "ts" })).code;
  for (const accepted of [false, true]) {
    const queued: string[] = [], prompts: string[] = [], errors: string[] = [];
    const context = {
      prompt: "Check page 2", alive: { current: true }, locked: true, busyRef: { current: true },
      loop: { current: { run: () => assert.fail("must not start a concurrent run") } },
      directions: { current: { loop: { steer: (text: string) => { queued.push(text); return { accepted, reason: "Queue full" }; } } } },
      setPrompt: (text: string) => prompts.push(text), setError: (text: string) => errors.push(text), setNotice: () => undefined,
    };
    const send = new Function("context", `const { ${Object.keys(context).join(", ")} } = context; ${code}; return send;`)(context);
    await send();
    assert.deepEqual(queued, ["Check page 2"]);
    assert.deepEqual(prompts, accepted ? [""] : []);
    if (!accepted) assert.deepEqual(errors, ["Queue full"]);
  }
});
