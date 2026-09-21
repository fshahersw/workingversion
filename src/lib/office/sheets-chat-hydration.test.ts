import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import ts from 'typescript'
import { transform } from 'esbuild'

async function actualEffect(context: Record<string, unknown>): Promise<() => void | (() => void)> {
  const source = await readFile(new URL('../../office/sheets/src/renderer/App.tsx', import.meta.url), 'utf8')
  const tree = ts.createSourceFile('App.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  let expression: ts.Expression | undefined
  function visit(node: ts.Node) {
    if (ts.isCallExpression(node) && node.expression.getText(tree) === 'useEffect'
      && node.arguments[0]?.getText(tree).includes('hydratedChatScopeRef')) expression = node.arguments[0]
    ts.forEachChild(node, visit)
  }
  visit(tree); assert.ok(expression)
  const code = (await transform(`const effect = ${expression.getText(tree)};`, { loader: 'ts' })).code
  return new Function('context', `const { ${Object.keys(context).join(',')} }=context; ${code}; return effect;`)(context)
}
const tick = () => new Promise(resolve => setTimeout(resolve, 0))
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r }); return { promise, resolve } }
function fixture() {
  const history: unknown[] = [], live: unknown[] = [], restored: unknown[] = []
  let resets = 0
  const ids = { current: null as null | { projectId: string; chatId: string } }
  const scope = { current: null as string | null }
  const resetEpoch = { current: 0 }
  const context = {
    workbookFile: { sessionId: 'first' }, chatRefIdsRef: ids, hydratedChatScopeRef: scope,
    chatResetEpochRef: resetEpoch,
    setHistoricChat: (value: unknown) => history.push(value), setChat: (value: unknown) => live.push(value),
    agentLoopRef: { current: { reset: () => { resets++ }, restore: (value: unknown) => restored.push(value) } },
  }
  return { context, ids, scope, resetEpoch, history, live, restored, resets: () => resets }
}
test('actual Sheets history effect skips rehydration after Save replaces only the engine session', async () => {
  const f = fixture(); let loads = 0
  const api = { resolveChat: async () => ({ projectId: 'doc', chatId: 'doc' }), loadChat: async () => { loads++; return [{ role: 'user', text: 'original task' }] } }
  const effect = await actualEffect({ ...f.context, window: { projectApi: api } })
  const cleanup = effect(); await tick()
  assert.equal(loads, 1); assert.equal(f.restored.length, 1)
  const beforeHistory = f.history.length
  cleanup?.(); f.context.workbookFile.sessionId = 'saved-session'
  effect(); await tick()
  assert.equal(loads, 1); assert.equal(f.history.length, beforeHistory)
  assert.equal(f.live.length, 0); assert.equal(f.resets(), 0)
})
test('actual Sheets history effect rejects stale resolves and loads after scope replacement', async () => {
  const f = fixture(); const oldResolve = deferred<{ projectId: string; chatId: string }>()
  const oldLoad = deferred<any[]>(); let calls = 0
  const api = { resolveChat: () => calls++ === 0 ? oldResolve.promise : Promise.resolve({ projectId: 'B', chatId: 'B' }),
    loadChat: ({ chatId }: { chatId: string }) => chatId === 'A' ? oldLoad.promise : Promise.resolve([{ role: 'user', text: 'B task' }]) }
  const effect = await actualEffect({ ...f.context, window: { projectApi: api } })
  const cleanup = effect(); oldResolve.resolve({ projectId: 'A', chatId: 'A' }); await tick()
  cleanup?.(); effect(); await tick()
  const before = f.history.length; oldLoad.resolve([{ role: 'user', text: 'A task' }]); await tick()
  assert.deepEqual(f.ids.current, { projectId: 'B', chatId: 'B' }); assert.equal(f.history.length, before)
  assert.deepEqual(f.restored, [[{ role: 'user', text: 'B task' }]])
  const stale = deferred<{ projectId: string; chatId: string }>()
  api.resolveChat = () => stale.promise
  const stop = effect(); stop?.(); stale.resolve({ projectId: 'C', chatId: 'C' }); await tick()
  assert.equal(f.ids.current, null)
})

for (const phase of ['resolve', 'load']) {
  test(`New conversation during history ${phase} keeps the new conversation empty across later saves`, async () => {
    const f = fixture(), resolving = deferred<{ projectId: string; chatId: string }>(), loading = deferred<any[]>()
    let loads = 0
    const api = { resolveChat: () => resolving.promise, loadChat: () => { loads++; return loading.promise } }
    const effect = await actualEffect({ ...f.context, window: { projectApi: api } })
    const cleanup = effect()
    if (phase === 'load') { resolving.resolve({ projectId: 'doc', chatId: 'doc' }); await tick() }
    f.resetEpoch.current++ // handleNewChat invalidates any outstanding hydration
    resolving.resolve({ projectId: 'doc', chatId: 'doc' })
    loading.resolve([{ role: 'user', text: 'old conversation' }]); await tick()
    assert.equal(f.restored.length, 0)
    assert.ok(f.history.every(value => Array.isArray(value) && value.length === 0))
    assert.equal(f.scope.current, JSON.stringify(['doc', 'doc']))
    const beforeLoads = loads
    cleanup?.(); effect(); await tick()
    assert.equal(loads, beforeLoads)
    assert.equal(f.restored.length, 0)
  })
}
