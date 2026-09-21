import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFile } from 'node:fs/promises'
import ts from 'typescript'
import { transform } from 'esbuild'

async function actualSend(context: Record<string, unknown>): Promise<() => Promise<void>> {
  const source = await readFile(new URL('../../office/sheets/src/renderer/App.tsx', import.meta.url), 'utf8')
  const tree = ts.createSourceFile('App.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  let declaration: ts.FunctionDeclaration | undefined
  function visit(node: ts.Node) {
    if (ts.isFunctionDeclaration(node) && node.name?.text === 'handleSend') declaration = node
    ts.forEachChild(node, visit)
  }
  visit(tree); assert.ok(declaration)
  const code = (await transform(declaration.getText(tree), { loader: 'ts' })).code
  return new Function('context', `const {${Object.keys(context).join(',')}}=context; ${code}; return handleSend`)(context)
}
for (const changed of ['commit', 'workbook', 'conversation', 'another run', 'unmount', 'none']) {
  test(`actual Sheets send preserves input after pending approval when ${changed} changes`, async () => {
    let approve!: () => void, committing = false, prompt = 'queued request', persisted = 0, sent = 0, bubbles = 0
    const approval = new Promise<void>(resolve => { approve = resolve })
    const workbook = { current: {} }, resetEpoch = { current: 0 }, starting = { current: false }, mounted = { current: true }
    const loop = { conversationVersion: 1, busy: false }
    const context = {
      prompt, aiBusy: false, runStartingRef: starting, lazyWorkbookRef: workbook,
      agentLoopRef: { current: loop }, chatResetEpochRef: resetEpoch, aiSaveLockRef: { current: false },
      isWorkbookSaveCommitting: () => committing, recoveryMountedRef: mounted,
      aiSettingsRef: { current: {} }, modeName: () => 'research',
      window: { desktopApi: { swApproveResearch: () => approval } }, setMessage: () => {},
      runToolsRef: { current: [] }, attachmentsRef: { current: [] }, isAgentConfigured: () => true,
      chat: [], persistChatMessage: () => { persisted++; return true },
      appendChat: () => { bubbles++ }, setPrompt: (text: string) => { prompt = text },
      runAgent: () => { sent++ },
    }
    const send = await actualSend(context), pending = send()
    if (changed === 'commit') committing = true
    else if (changed === 'workbook') workbook.current = {}
    else if (changed === 'conversation') { resetEpoch.current++; loop.conversationVersion++ }
    else if (changed === 'another run') starting.current = true
    else if (changed === 'unmount') mounted.current = false
    approve(); await pending
    const valid = changed === 'none'
    assert.equal(prompt, valid ? '' : 'queued request')
    assert.equal(persisted, valid ? 1 : 0)
    assert.equal(sent, valid ? 1 : 0)
    assert.equal(bubbles, valid ? 1 : 0)
  })
}
