import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFile } from 'node:fs/promises'
import { transform } from 'esbuild'
import { localOfficeCapabilities } from './local-capabilities.server.ts'
import type { AgentToolDef } from '../writer/inference.server.ts'
import { streamWriterTurn, type AgentToolCall } from '../writer/inference.server.ts'

const tool = (name: string): AgentToolDef => ({ name, description: name, inputSchema: { type: 'object', properties: { kind: { type: 'string' }, engine: { type: 'string' }, style: { type: 'string' }, source: { type: 'string' } } } })
const request = { system: 'Use exact calculations.\n## Platform tools\n- run_python: always use this for figures.\n- generate_image / edit_image: create pictures.\n- create_document: Word, Excel, PowerPoint and PDF.\n- search_library: find local documents.\nPreserve the user request.', tools: ['run_python', 'load_attachment_for_python', 'generate_image', 'edit_image', 'search_firm_knowledge', 'web_search', 'image_search', 'verify_citations', 'fetch_page', 'search_library', 'render_diagram', 'create_document', 'propose_operations', 'read_range', 'aggregate_range'].map(tool) }
const env = { LOCAL_SYNTHETIC_MODE: '1', NODE_ENV: 'development', OFFICE_LOCAL_PROVIDER: 'anthropic', OFFICE_LOCAL_ANTHROPIC_MODEL: 'claude-sonnet-4-6', ANTHROPIC_API_KEY: 'unit-test-only' }

test('production manifest and prompt remain exactly unchanged; local mode cannot activate in AWS', () => {
  assert.equal(localOfficeCapabilities(request, {}), request)
  assert.equal(localOfficeCapabilities(request, { NODE_ENV: 'production' }), request)
  assert.throws(() => localOfficeCapabilities(request, { ...env, NODE_ENV: 'production' }), /restricted/)
  assert.throws(() => localOfficeCapabilities(request, { ...env, AWS_EXECUTION_ENV: 'AWS_Lambda_nodejs22.x' }), /restricted/)
})

test('local provider sees native workbook tools and configured research, never unavailable AWS tools', () => {
  const result = localOfficeCapabilities(request, env)
  assert.deepEqual(result.tools.map(t => t.name), ['web_search', 'fetch_page', 'search_library', 'render_diagram', 'create_document', 'propose_operations', 'read_range', 'aggregate_range'])
  assert.doesNotMatch(result.system, /run_python: always|generate_image \/ edit_image:|create_document: Word/)
  assert.match(result.system, /search_library: find local documents/)
  assert.match(result.system, /Preserve the user request/)
  assert.match(result.system, /workbook formulas/)
  assert.match(result.system, /Generic guides and earlier tool references do not enable missing tools/)
  assert.ok(request.tools.some(t => t.name === 'run_python'), 'input manifest is not mutated')
})

test('mixed capabilities expose only browser Mermaid and native PPTX branches', () => {
  const result = localOfficeCapabilities(request, env)
  const diagram = result.tools.find(t => t.name === 'render_diagram')!
  const document = result.tools.find(t => t.name === 'create_document')!
  assert.deepEqual((diagram.inputSchema.properties as Record<string, unknown>).kind, { type: 'string', enum: ['mermaid'] })
  assert.equal('engine' in (diagram.inputSchema.properties as object), false)
  assert.deepEqual((document.inputSchema.properties as Record<string, unknown>).kind, { type: 'string', enum: ['pptx'] })
  assert.equal('style' in (document.inputSchema.properties as object), false)
})

test('actual Writer create_document retains its type discriminator and HTML content contract locally', async () => {
  const source = await readFile(new URL('../../writer/renderer/ai/tools.ts', import.meta.url), 'utf8')
  const start = source.indexOf('export const AGENT_TOOLS:')
  const end = source.indexOf('\n];', start)
  assert.ok(start >= 0 && end > start)
  // Evaluate the real definition array without loading the browser editor.
  const { code } = await transform(source.slice(start, end + 3), { loader: 'ts', format: 'esm' })
  const actual = await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`)
  const writerTool = actual.AGENT_TOOLS.find((entry: AgentToolDef) => entry.name === 'create_document') as AgentToolDef
  assert.ok(writerTool)
  const request = { system: 'Create the requested separate document.', tools: [writerTool] }
  const filtered = localOfficeCapabilities(request, env).tools[0]!
  const fields = filtered.inputSchema.properties as Record<string, any>
  assert.deepEqual(fields.type.enum, ['pptx'])
  assert.equal('kind' in fields, false)
  assert.deepEqual(new Set(filtered.inputSchema.required as string[]), new Set(['type', 'title', 'content']))
  assert.equal(filtered.inputSchema.additionalProperties, false)
  assert.match(fields.content.description, /Restricted HTML/)
  assert.match(filtered.description, /Set type to pptx explicitly/)
  assert.match(filtered.description, /DOCX, PDF and Markdown creation are unavailable/)
  assert.equal(localOfficeCapabilities(request, { NODE_ENV: 'production' }), request)
  assert.deepEqual((writerTool.inputSchema.properties as Record<string, any>).type.enum, ['docx', 'pptx', 'pdf', 'md'])
})

test('optional public capabilities reflect explicit provider configuration', () => {
  const names = (config: Record<string, string | undefined>) => localOfficeCapabilities(request, config).tools.map(t => t.name)
  assert.ok(!names({ ...env, ANTHROPIC_API_KEY: '' }).includes('web_search'))
  assert.ok(!names({ ...env, OFFICE_LOCAL_PROVIDER: 'fireworks' }).includes('web_search'))
  assert.ok(names({ ...env, OFFICE_LOCAL_PROVIDER: 'fireworks', OFFICE_LOCAL_SEARCH_PROVIDER: 'anthropic' }).includes('web_search'))
  const configured = names({ ...env, COURTLISTENER_API_TOKEN: 'unit-test', TAVILY_API_KEY: 'unit-test' })
  assert.ok(configured.includes('image_search'))
  assert.ok(configured.includes('verify_citations'))
})

test('unverified Fireworks vision omits every image-returning tool while retaining native data and style checks', () => {
  const imageTools = ['view_range', 'view_page', 'view_slide', 'pdf_capture_page', 'render_diagram', 'analyze_media']
  const nativeTools = ['read_range', 'read_formats', 'read_sheet_features', 'aggregate_range', 'read_blocks', 'read_slide', 'audit_layout', 'pdf_read_pages', 'pdf_list_form_fields', 'read_attachment', 'propose_operations']
  const candidate = { system: 'Preserve the requested data and styles.\n- view_page: inspect the current rendering.', tools: [...imageTools, ...nativeTools].map(tool) }
  const noVision = localOfficeCapabilities(candidate, { ...env, OFFICE_LOCAL_PROVIDER: 'fireworks' })
  assert.deepEqual(noVision.tools.map(t => t.name), nativeTools)
  assert.match(noVision.system, /Visual inspection is unavailable/)
  assert.match(noVision.system, /Do not claim to have visually inspected/)
  assert.doesNotMatch(noVision.system, /view_page: inspect/)
  for (const configured of [env, { ...env, OFFICE_LOCAL_PROVIDER: 'fireworks', OFFICE_LOCAL_FIREWORKS_VISION: '1' }]) {
    const result = localOfficeCapabilities(candidate, configured)
    assert.deepEqual(result.tools.map(t => t.name), [...imageTools, ...nativeTools])
    assert.doesNotMatch(result.system, /Visual inspection is unavailable/)
  }
  assert.equal(localOfficeCapabilities(candidate, { NODE_ENV: 'production' }), candidate)
})

test('actual local inference transport filters AWS tools and rejects a returned unavailable Python call', async () => {
  const configured: Record<string, string | undefined> = { ...env, APP_ENVIRONMENT: 'local', AWS_LAMBDA_FUNCTION_NAME: undefined, AWS_EXECUTION_ENV: undefined, ECS_CONTAINER_METADATA_URI: undefined, ECS_CONTAINER_METADATA_URI_V4: undefined, OFFICE_LOCAL_MAX_TOKENS: '1000' }
  const previous = Object.fromEntries(Object.keys(configured).map(key => [key, process.env[key]]))
  const originalFetch = globalThis.fetch
  const calls: AgentToolCall[] = []
  try {
    for (const [key, value] of Object.entries(configured)) { if (value === undefined) delete process.env[key]; else process.env[key] = value }
    globalThis.fetch = (async (_url, init) => {
      const body = JSON.parse(String(init?.body))
      assert.ok(!body.tools.some((t: { name: string }) => t.name === 'run_python'))
      assert.ok(body.tools.some((t: { name: string }) => t.name === 'propose_operations'))
      assert.match(body.system, /Current local workspace capabilities/)
      const events = [
        { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'python-denied', name: 'run_python', input: {} } },
        { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"code":"print(1)"}' } },
        { type: 'content_block_stop', index: 0 },
        { type: 'message_delta', delta: { stop_reason: 'tool_use' } },
        { type: 'message_stop' },
      ]
      return new Response(events.map(event => `data: ${JSON.stringify(event)}\n\n`).join(''), { headers: { 'content-type': 'text/event-stream' } })
    }) as typeof fetch
    await streamWriterTurn({ ...request, app: 'sheets', profile: 'standard', model: 'claude-sonnet-4-6', messages: [{ role: 'user', text: 'Build a mock quarterly workbook using formulas.' }], signal: new AbortController().signal }, {
      onDelta() {}, onReasoning() {}, onStopReason() {}, onToolCall(call) { calls.push(call) },
    })
    assert.equal(calls.length, 1)
    assert.match(calls[0]!.inputError ?? '', /not allowed/)
    assert.deepEqual(calls[0]!.input, {}, 'unavailable code never reaches an executable proposal')
  } finally {
    globalThis.fetch = originalFetch
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value }
  }
})
