import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import ts from "typescript";
import { transform } from "esbuild";
import { activityStatus } from "../../writer/packages/ui/src/sw-assistant/core";

async function sourceTree(relative: string) {
  const source = await readFile(new URL(relative, import.meta.url), "utf8");
  return ts.createSourceFile(relative, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
}

for (const [app, path] of [
  ["Writer", "../../writer/renderer/ai/AiPanel.tsx"],
  ["Sheets", "../../office/sheets/src/renderer/App.tsx"],
  ["Slides", "../../office/slides/src/renderer/ai/AiPanel.tsx"],
] as const) {
  test(`${app} actual activity adapter preserves deliberately skipped status in UI and persistence`, async () => {
    const tree = await sourceTree(path);
    let expression: ts.Expression | undefined;
    function visit(node: ts.Node) {
      if (ts.isPropertyAssignment(node) && node.name.getText(tree) === "onToolExecuted") expression = node.initializer;
      ts.forEachChild(node, visit);
    }
    visit(tree);
    assert.ok(expression);
    const code = (await transform(`const handler = ${expression.getText(tree)};`, { loader: "ts" })).code;
    const runToolsRef = { current: [] as Array<{ skipped?: boolean; isError?: boolean; summary: string }> };
    let entry = { tools: [{ id: "skip", startedAt: 100, running: true, summary: "Pending" }] };
    const context = {
      runToolsRef, runMutatedRef: { current: false }, runSnapshotRef: { current: null }, lastTurnToolsRef: { current: [] },
      safeJsonInput: JSON.stringify, PERSIST_TOOL_FIELD_MAX: 1000, TOOL_OUTPUT_MAX_CHARS: 1000,
      patchLastAssistant: (update: (value: typeof entry) => typeof entry) => { entry = { ...entry, ...update(entry) }; },
    };
    const handler = new Function("context", `const { ${Object.keys(context).join(", ")} } = context; ${code}; return handler;`)(context);
    handler({ call: { id: "skip", name: "write", input: {} }, execution: { output: "Not executed", summary: "Skipped after updated directions", skipped: true, isError: true } });
    assert.equal(entry.tools.length, 1);
    assert.equal(entry.tools[0]?.startedAt, 100);
    assert.equal(activityStatus(entry.tools[0]!), "skipped");
    assert.equal(runToolsRef.current.length, 1);
    assert.equal(runToolsRef.current[0]?.skipped, true);
    assert.equal(runToolsRef.current[0]?.isError, true);
  });
}

test("Office chat serializer keeps only a literal skipped boolean for later activity rendering", async () => {
  const tree = await sourceTree("./office.server.ts");
  const declaration = tree.statements.find(statement => ts.isFunctionDeclaration(statement) && statement.name?.text === "cleanTools");
  assert.ok(declaration);
  const code = (await transform(declaration.getText(tree), { loader: "ts" })).code;
  const clean = new Function("s", "MAX_TOOL_FIELD", `${code}; return cleanTools;`)((value: unknown) => String(value ?? ""), 1000);
  const tools = clean([
    { name: "write", summary: "Skipped after updated directions", skipped: true, isError: true },
    { name: "write", summary: "Actual failure", skipped: "true", isError: true },
  ]);
  assert.equal(activityStatus(tools[0]), "skipped");
  assert.equal(activityStatus(tools[1]), "failed");
  assert.equal("skipped" in tools[1], false);
});
