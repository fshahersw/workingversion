import assert from 'node:assert/strict'
import { test } from 'node:test'
import { localPublicSearch, parseLocalPublicSearch } from './local-public-search.server.ts'

const env = { LOCAL_SYNTHETIC_MODE: '1', OFFICE_LOCAL_PROVIDER: 'anthropic', OFFICE_LOCAL_ANTHROPIC_MODEL: 'claude-sonnet-4-6', ANTHROPIC_API_KEY: 'synthetic-test-key', OFFICE_LOCAL_ANTHROPIC_WORKSPACE_ID: 'synthetic-workspace' }
const payload = (hits: unknown[] = [{ type: 'web_search_result', title: 'Official quarterly results', url: 'https://ir.example.com/quarterly-results', encrypted_content: 'opaque' }]) => ({ content: [
  { type: 'server_tool_use', id: 'search-1', name: 'web_search', input: { query: 'test' } },
  { type: 'web_search_tool_result', tool_use_id: 'search-1', content: hits },
  { type: 'text', text: 'A generated answer https://invented.example/data', citations: [{ type: 'web_search_result_location', url: 'https://ir.example.com/quarterly-results', cited_text: 'Revenue for the reported quarter was $123 million.' }] },
] })

test('local search uses only actual search URLs and their cited source excerpts', () => {
  const result = parseLocalPublicSearch(payload(), 6)
  assert.equal(result.method, 'anthropic-public-search')
  assert.deepEqual(result.results, [{ title: 'Official quarterly results', url: 'https://ir.example.com/quarterly-results', snippet: 'Revenue for the reported quarter was $123 million.' }])
  assert.doesNotMatch(JSON.stringify(result), /invented|opaque|generated answer/)
  assert.equal(parseLocalPublicSearch({ content: [{ type: 'text', text: 'No results exist.' }] }, 6).method, 'error')
})

test('search outages and rejected URLs remain errors; genuine empty search is distinguishable', () => {
  const error = payload()
  error.content[1]!.content = { type: 'web_search_tool_result_error', error_code: 'unavailable' } as never
  assert.equal(parseLocalPublicSearch(error, 6).method, 'error')
  const invalid = ['http://127.0.0.1/', 'http://169.254.169.254/', 'file:///etc/passwd', 'https://user:secret@example.org/', 'https://example.org:8443/']
  assert.equal(parseLocalPublicSearch(payload(invalid.map(url => ({ type: 'web_search_result', url }))), 6).method, 'error')
  assert.deepEqual(parseLocalPublicSearch(payload([]), 6), { results: [], method: 'anthropic-public-search' })
  const unpaired = payload()
  unpaired.content[1]!.tool_use_id = 'unknown'
  assert.equal(parseLocalPublicSearch(unpaired, 6).method, 'error')
})

test('guarded local search sends a bounded native provider search and preserves workspace authentication', async () => {
  let calls = 0
  const result = await localPublicSearch('Example company quarterly financial results', 3, { env, fetchImpl: async (url, init) => {
    calls++
    assert.equal(url, 'https://api.anthropic.com/v1/messages')
    assert.equal(init?.redirect, 'error')
    const headers = init?.headers as Record<string, string>
    assert.equal(headers['anthropic-workspace-id'], 'synthetic-workspace')
    const body = JSON.parse(String(init?.body))
    assert.equal(body.model, 'claude-sonnet-4-6')
    assert.deepEqual(body.tools, [{ type: 'web_search_20250305', name: 'web_search', max_uses: 2 }])
    assert.equal(body.max_tokens, 1200)
    return Response.json(payload())
  } })
  assert.equal(calls, 1)
  assert.equal(result.results.length, 1)
})

test('production, AWS and missing local credentials cannot trigger external search or AWS fallback', async () => {
  let calls = 0
  const fetchImpl = async () => { calls++; throw new Error('must not reach network') }
  for (const overrides of [{ LOCAL_SYNTHETIC_MODE: '0' }, { NODE_ENV: 'production' }, { AWS_LAMBDA_FUNCTION_NAME: 'hosted' }, { APP_ENVIRONMENT: 'testing' }]) {
    await assert.rejects(localPublicSearch('public sources', 6, { env: { ...env, ...overrides }, fetchImpl }))
  }
  assert.equal((await localPublicSearch('public sources', 6, { env: { ...env, ANTHROPIC_API_KEY: '' }, fetchImpl })).method, 'error')
  assert.equal((await localPublicSearch('public sources', 6, { env: { ...env, OFFICE_LOCAL_PROVIDER: 'fireworks' }, fetchImpl })).method, 'error')
  assert.equal(calls, 0)
})

test('search handles HTTP failures, stalled transports/bodies and cancellation without leaking provider bodies', async () => {
  const http = await localPublicSearch('public sources', 6, { env, fetchImpl: async () => new Response('secret-provider-body', { status: 403 }) })
  assert.match(http.error!, /HTTP 403/)
  assert.doesNotMatch(http.error!, /secret-provider-body/)
  for (const fetchImpl of [
    async () => new Promise<Response>(() => {}),
    async () => new Response(new ReadableStream({ start() {} })),
  ]) {
    const started = performance.now()
    const result = await localPublicSearch('public sources', 6, { env, fetchImpl, timeoutMs: 10 })
    assert.equal(result.method, 'error')
    assert.ok(performance.now() - started < 1000, 'complete wall-clock deadline must bound fetch and body')
  }
  let calls = 0
  assert.equal((await localPublicSearch('public sources', 6, { env, signal: AbortSignal.abort(), fetchImpl: async () => { calls++; throw Error('unused') } })).method, 'error')
  assert.equal(calls, 0)
})
