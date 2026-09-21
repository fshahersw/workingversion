import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import { transform } from 'esbuild'
import ts from 'typescript'

function declaration(source: string, name: string) {
  const ast = ts.createSourceFile('actual.ts', source, ts.ScriptTarget.Latest, true)
  const fn = ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === name)
  assert.ok(fn, name)
  return fn.getText(ast)
}
const source = await readFile(new URL('../../office/sheets/src/renderer/univer-sync.ts', import.meta.url), 'utf8')
const code = (await transform(declaration(source, 'applyFormatPatchToRange'), { loader: 'ts', format: 'esm' })).code
const { applyFormatPatchToRange } = await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`)
const facade = await readFile(new URL('../../../node_modules/@univerjs/sheets/lib/es/facade.js', import.meta.url), 'utf8')
const transformAlignment = new Function('HorizontalAlign', `${declaration(facade, 'transformFacadeHorizontalAlignment')}; return transformFacadeHorizontalAlignment;`)({ LEFT: 1, CENTER: 2, RIGHT: 3 })

test('actual format adapter maps left/center/right into the installed facade contract', () => {
  for (const [requested, expected] of [['left', 1], ['center', 2], ['right', 3]] as const) {
    let alignment
    applyFormatPatchToRange({ setHorizontalAlignment: (value: string) => { alignment = transformAlignment(value) } }, { horizontalAlign: requested })
    assert.equal(alignment, expected)
  }
})

test('actual null alignment clears only the explicit style; omission performs no writes', () => {
  const writes: unknown[] = []
  const range = { setHorizontalAlignment: () => assert.fail('reset must not mean right alignment'), setValue: (value: unknown) => writes.push(value) }
  applyFormatPatchToRange(range, { horizontalAlign: null })
  assert.deepEqual(writes, [{ s: { ht: null } }])
  applyFormatPatchToRange(range, {})
  assert.equal(writes.length, 1)
})
