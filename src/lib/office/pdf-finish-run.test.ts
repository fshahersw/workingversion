import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import ts from "typescript";
import { transform } from "esbuild";

async function finishCallback(context: Record<string, unknown>) {
  const source = await readFile(new URL("../../office/pdf/PdfWorkspace.tsx", import.meta.url), "utf8");
  const tree = ts.createSourceFile("PdfWorkspace.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let expression: ts.Expression | undefined;
  function visit(node: ts.Node) {
    if (ts.isVariableDeclaration(node) && node.name.getText(tree) === "finishRun") expression = node.initializer;
    ts.forEachChild(node, visit);
  }
  visit(tree);
  assert.ok(expression);
  const code = (await transform(`const finish = ${expression.getText(tree)};`, { loader: "ts" })).code;
  return new Function("context", `const { ${Object.keys(context).join(", ")} } = context; ${code}; return finish;`)(context) as (text: string, outcome: string) => Promise<void>;
}

test("PDF actual failed-run callback saves its full checkpoint even if rollback fails, before releasing busy", async () => {
  const original = '[Task interrupted — not completed]\nReason: network\n' + 'Full source receipts. '.repeat(900);
  const busyRef = { current: true };
  const appended: Array<{ role: string; text: string }> = [];
  const notices: string[] = [], errors: string[] = [];
  let release!: () => void, saving!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { saving = resolve; });
  const finish = await finishCallback({
    runStart: { current: new Uint8Array([1]) }, alive: { current: true }, busyRef, loop: { current: {} },
    current: () => ({ bytes: new Uint8Array([2]), revision: 1 }),
    install: async () => { throw new Error("Synthetic rollback failure"); },
    keepUndo: () => assert.fail("a failed run must attempt rollback"),
    append: async (message: { role: string; text: string }) => { appended.push(message); saving(); await pending; },
    setNotice: (text: string) => notices.push(text), setError: (text: string) => errors.push(text),
    setBusy: (busy: boolean) => assert.equal(busy, false), setReply: () => undefined,
    messageOf: (error: Error) => error.message,
  });
  const completion = finish(original, "failed");
  await started;
  assert.equal(busyRef.current, true);
  assert.equal(appended.length, 1);
  assert.ok(appended[0]!.text.startsWith(original + '\n\n'));
  assert.match(appended[0]!.text, /Recovery was incomplete/);
  assert.doesNotMatch(appended[0]!.text, /were rolled back/);
  assert.match(errors.join(' '), /Synthetic rollback failure/);
  assert.doesNotMatch(notices.join(' '), /were rolled back/);
  release(); await completion;
  assert.equal(busyRef.current, false);
});

test("PDF successful rollback preserves checkpoint verbatim and unmounted recovery cannot append", async () => {
  for (const unmount of [false, true]) {
    const alive = { current: true };
    const appended: string[] = [], notices: string[] = [];
    const finish = await finishCallback({
      runStart: { current: new Uint8Array([1]) }, alive, busyRef: { current: true }, loop: { current: {} },
      current: () => ({ bytes: new Uint8Array([2]), revision: 1 }),
      install: async () => { if (unmount) alive.current = false; }, keepUndo: () => undefined,
      append: async (message: { text: string }) => { appended.push(message.text); },
      setNotice: (text: string) => notices.push(text), setError: () => assert.fail("unexpected failure"),
      setBusy: () => { assert.equal(unmount, false); }, setReply: () => undefined,
      messageOf: String,
    });
    await finish("Full original checkpoint", "failed");
    assert.deepEqual(appended, unmount ? [] : ["Full original checkpoint"]);
    if (unmount) assert.deepEqual(notices, []);
    else assert.match(notices.join(' '), /were rolled back/);
  }
});
