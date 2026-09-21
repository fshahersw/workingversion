import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import ts from "typescript";
import { transform } from "esbuild";

async function onDone(app: "sheets" | "slides", context: Record<string, unknown>) {
  const relative = app === "sheets" ? "../../office/sheets/src/renderer/App.tsx" : "../../office/slides/src/renderer/ai/AiPanel.tsx";
  const source = await readFile(new URL(relative, import.meta.url), "utf8");
  const tree = ts.createSourceFile(relative, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let expression: ts.Expression | undefined;
  function visit(node: ts.Node) {
    if (ts.isPropertyAssignment(node) && node.name.getText(tree) === "onDone") expression = node.initializer;
    ts.forEachChild(node, visit);
  }
  visit(tree); assert.ok(expression);
  const code = (await transform(`const callback = ${expression.getText(tree)};`, { loader: "ts" })).code;
  return new Function("context", `const { ${Object.keys(context).join(", ")} } = context; ${code}; return callback;`)(context);
}

test("Sheets actual completion callback labels partial outcomes without releasing busy before save settles", async () => {
  const noop = () => undefined;
  for (const [flags, status] of [[{ truncated: true }, "appAiTruncatedNote"], [{ turnLimit: true }, "appAiTurnLimit"], [{ cancelled: true }, "appAiStopped"], [{}, "appAiDone"]] as const) {
    const messages: string[] = [], busy: boolean[] = [];
    let release!: () => void;
    const save = new Promise<void>(resolve => { release = resolve; });
    const callback = await onDone("sheets", {
      setChat: noop, settleRunMessages: noop, runToolsRef: { current: [] }, runLastTextRef: { current: "" },
      runMutatedRef: { current: false }, COMPLETED_VIA_TOOLS_TEXT: "(completed tool actions; no text reply)",
      t: (key: string) => key, setMessage: (text: string) => messages.push(text),
      patchLastAssistant: noop, persistChatMessage: noop, setAiRunScope: noop,
      autoSaveCompletedAiRun: () => save, aiSaveLockRef: { current: true }, setAiBusy: (value: boolean) => busy.push(value),
    });
    callback({ text: "Partial paragraph", cancelled: false, turnLimit: false, ...flags });
    assert.equal(messages[0], status);
    assert.deepEqual(busy, []);
    release(); await new Promise(resolve => setTimeout(resolve, 0));
    assert.deepEqual(busy, [false]);
  }
});

test("Slides actual partial completion closes its batch without launching completion QC or advancing a successful queue result", async () => {
  const noop = () => undefined;
  for (const partial of [false, true]) {
    let qc = 0;
    const queue: boolean[] = [];
    const callback = await onDone("slides", {
      setChat: noop, settleRunMessages: noop, tGlobal: (key: string) => key,
      runToolsRef: { current: [] }, finishHistoryBatch: async () => undefined, setBusy: noop,
      qcPagesRef: { current: [1] }, runQcPassRef: { current: () => { qc++; } },
      queueRunResolverRef: { current: (value: boolean) => queue.push(value) }, persistMessage: noop,
      streamedTextRef: { current: "" }, logRunFailure: noop,
    });
    callback({ text: "Response", cancelled: false, turnLimit: partial });
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.deepEqual(queue, [!partial]);
    assert.equal(qc, partial ? 0 : 1);
  }
});
