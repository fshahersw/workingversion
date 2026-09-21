import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFile } from 'node:fs/promises'
import ts from 'typescript'
import { transform } from 'esbuild'
import { beginWorkbookSaveCommit, isWorkbookSaveCommitting } from '../../office/sheets/src/renderer/save-commit-lock'

test('save commit blocks user input only during commit and restores listeners after release', () => {
  const globals = globalThis as unknown as Record<string, unknown>, previous = globals.document
  const target = new EventTarget(), state = {}
  globals.document = target
  const release = beginWorkbookSaveCommit(state)
  try {
    assert.equal(isWorkbookSaveCommitting(state), true)
    assert.equal(isWorkbookSaveCommitting({}), false)
    for (const name of ['pointerdown', 'click', 'keydown', 'beforeinput', 'paste', 'drop', 'submit']) {
      const event = new Event(name, { cancelable: true })
      target.dispatchEvent(event)
      assert.equal(event.defaultPrevented, true, name)
    }
    assert.throws(() => beginWorkbookSaveCommit(state), /already in progress/)
  } finally { release(); globals.document = previous }
  assert.equal(isWorkbookSaveCommitting(state), false)
  const after = new Event('keydown', { cancelable: true }); target.dispatchEvent(after)
  assert.equal(after.defaultPrevented, false)
})

test('actual Sheets command gate rejects commit-time mutations and permits internal load/formula work', async () => {
  const source = await readFile(new URL('../../office/sheets/src/renderer/App.tsx', import.meta.url), 'utf8')
  const tree = ts.createSourceFile('App.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  let expression: ts.Expression | undefined
  function visit(node: ts.Node) {
    if (ts.isCallExpression(node) && node.arguments[0]?.getText(tree).endsWith('Event.BeforeCommandExecute')
      && node.arguments[1]?.getText(tree).includes('isWorkbookSaveCommitting')) expression = node.arguments[1]
    ts.forEachChild(node, visit)
  }
  visit(tree); assert.ok(expression)
  const code = (await transform(`const gate = ${expression.getText(tree)};`, { loader: 'ts' })).code
  const state = {}, suppression = { active: false }
  const context = { lazyWorkbookRef: { current: state }, journalSuppression: suppression,
    isWorkbookSaveCommitting, SET_RANGE_VALUES_COMMAND: 'set', SET_RANGE_VALUES_MUTATION: 'mutation' }
  const gate = new Function('context', `const {${Object.keys(context).join(',')}}=context; ${code}; return gate`)(context)
  const release = beginWorkbookSaveCommit(state)
  try {
    const edit = { id: 'mutation', cancel: false }; gate(edit); assert.equal(edit.cancel, true)
    const calculation = { id: 'mutation', options: { fromFormula: true }, cancel: false }
    gate(calculation); assert.equal(calculation.cancel, false)
    suppression.active = true
    const load = { id: 'internal-load', cancel: false }; gate(load); assert.equal(load.cancel, false)
  } finally { release() }
})
