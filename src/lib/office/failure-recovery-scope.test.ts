import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import ts from "typescript";
import { transform } from "esbuild";

// Execute the actual renderer callback, supplying only its surrounding React/API
// dependencies. This catches a removed ownership check in the owning UI seam.
async function callback(app: "sheets" | "slides", context: Record<string, unknown>) {
  const relative = app === "sheets" ? "../../office/sheets/src/renderer/App.tsx" : "../../office/slides/src/renderer/ai/AiPanel.tsx";
  const source = await readFile(new URL(relative, import.meta.url), "utf8");
  const tree = ts.createSourceFile(relative, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let expression: ts.Expression | undefined;
  function visit(node: ts.Node) {
    if (ts.isPropertyAssignment(node) && node.name.getText(tree) === "onError" && node.initializer.getText(tree).includes("const failedLoop")) expression = node.initializer;
    ts.forEachChild(node, visit);
  }
  visit(tree);
  assert.ok(expression, "the renderer must expose its actual failure callback");
  const code = (await transform(`const handler = ${expression.getText(tree)};`, { loader: "ts" })).code;
  return new Function("context", `const { ${Object.keys(context).join(", ")} } = context; ${code}; return handler;`)(context) as (error: string) => void;
}

test("Sheets failure cleanup cannot persist, restore, save, or unlock a different conversation", async () => {
  let finalizer!: { restore: () => Promise<boolean>; save: (results: unknown[]) => Promise<void>; finish: () => void };
  const loop = { conversationVersion: 1, failureCheckpoint: "original task" };
  const chat = { current: { projectId: "A", chatId: "A" } };
  const tools = { current: [{ name: "read", summary: "old receipt" }] };
  const persisted: unknown[][] = [];
  let busyUpdates = 0;
  let saves = 0;
  const noop = () => undefined;
  const handler = await callback("sheets", {
    agentLoopRef: { current: loop }, chatRefIdsRef: chat, runToolsRef: tools,
    recoveryMountedRef: { current: true }, lazyWorkbookRef: { current: {} },
    setChat: noop, settleRunMessages: noop, setMessage: noop,
    finalizeFailedRun: (steps: typeof finalizer) => { finalizer = steps; },
    persistChatMessage: (...args: unknown[]) => persisted.push(args),
    aiSaveLockRef: { current: true }, setAiRunScope: noop, setAiBusy: () => { busyUpdates++; },
    autoSaveCompletedAiRun: async () => { saves++; },
    aiApplyPromisesRef: { current: [] }, runMutatedRef: { current: false },
  });
  handler("interrupted");
  chat.current = { projectId: "B", chatId: "B" };
  loop.conversationVersion++;
  tools.current = [{ name: "write", summary: "new receipt" }];
  assert.equal(await finalizer.restore(), false);
  await finalizer.save([]);
  finalizer.finish();
  assert.equal(persisted.length, 0);
  assert.equal(saves, 0);
  assert.equal(busyUpdates, 0);

  // A current-scope failure persists the captured receipt even if mutable tool
  // refs change during asynchronous recovery.
  handler("second interruption");
  tools.current = [];
  finalizer.finish();
  assert.equal(persisted.length, 1);
  assert.deepEqual(persisted[0]?.[2], [{ name: "write", summary: "new receipt" }]);
  assert.equal(busyUpdates, 1);
});

test("Slides unmount while closing a failed batch cannot restore or persist into the next document", async () => {
  let release!: () => void;
  const closed = new Promise<void>(resolve => { release = resolve; });
  const mounted = { current: true };
  let restores = 0;
  let persisted = 0;
  let busyUpdates = 0;
  const noop = () => undefined;
  const handler = await callback("slides", {
    loopRef: { current: { conversationVersion: 1, failureCheckpoint: "original task" } },
    chatRefIds: { current: { projectId: "A", chatId: "A" } },
    runToolsRef: { current: [] }, recoveryMountedRef: mounted, runMutatedRef: { current: true },
    setChat: noop, settleRunMessages: noop, logRunFailure: noop, qcPagesRef: { current: [] },
    window: { slidesApi: { aiGskStatus: async () => ({ loggedIn: true }), aiSnapshotRestore: async () => { restores++; return []; } } },
    finishHistoryBatch: () => closed, runSnapshotIdRef: { current: 7 },
    persistMessage: () => { persisted++; }, setBusy: () => { busyUpdates++; },
    queueRunResolverRef: { current: null }, applyDeckRef: { current: noop }, currentRef: { current: 0 },
  });
  handler("interrupted");
  mounted.current = false;
  release();
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(restores, 0);
  assert.equal(persisted, 0);
  assert.equal(busyUpdates, 0);
});
