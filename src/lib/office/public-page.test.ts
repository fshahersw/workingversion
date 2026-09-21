import assert from 'node:assert/strict'
import { test } from 'node:test'
import { compactOfficePageText, officePageSlice, readOfficePublicPage } from './public-page.server.ts'
import type { ReadPageResult } from '../agents/page-read.server.ts'

const rows = Array.from({ length: 200 }, (_, i) => `2025 Q${i % 4 + 1}\tRevenue\t$${100 + i} million\tMargin 20%`).join('\n')
const page = (text = rows): ReadPageResult => ({ url: 'https://ir.example.com/results', finalUrl: 'https://ir.example.com/results', status: 200, contentType: 'text/html', title: 'Official financial results', text, links: [], truncated: false, via: 'direct', blocked: null, source: {} as never })

test('Office excerpts compact whitespace while preserving repeated financial rows and exact numeric content', () => {
  assert.equal(compactOfficePageText('  Revenue   123\r\n\r\n\r\n  $123\t20%  \n$123\t20%'), 'Revenue 123\n\n$123\t20%\n$123\t20%')
  const source = page()
  let startChar = 0
  let revision: string | undefined
  const chunks: string[] = []
  for (;;) {
    const part = officePageSlice(source, { maxChars: 1000, startChar, revision })
    assert.ok(part.text.length <= 1000)
    if (part.nextStartChar !== null) assert.ok(part.text.endsWith('\n'), 'never split a numeric record across excerpts')
    chunks.push(part.text)
    revision = part.revision
    if (part.nextStartChar === null) break
    startChar = part.nextStartChar
  }
  assert.equal(chunks.join(''), rows)
  assert.equal(chunks.join('').split('\n').length, 200)
})

test('continuations require unchanged source revisions and returned line boundaries', () => {
  const first = officePageSlice(page(), { maxChars: 1000 })
  assert.throws(() => officePageSlice(page(), { startChar: first.nextStartChar! }), /requires the revision/)
  assert.throws(() => officePageSlice(page(rows.replace('$100', '$999')), { startChar: first.nextStartChar!, revision: first.revision }), /changed between reads/)
  assert.throws(() => officePageSlice(page(), { startChar: 1, revision: first.revision }), /line boundary/)
  assert.throws(() => officePageSlice(page('x'.repeat(24_001)), { maxChars: 1000 }), /line too large/)
})

test('blocked/empty pages are errors, not readable financial evidence; direct URL guards remain active', async () => {
  let calls = 0
  const reader = async () => { calls++; return page() }
  await assert.rejects(readOfficePublicPage('http://127.0.0.1/', {}, reader), /Blocked|loopback|private/i)
  assert.equal(calls, 0)
  await assert.rejects(readOfficePublicPage(page().url, {}, async () => ({ ...page(), status: 403, blocked: { blocked: true, reason: 'http-status', retryable: true, detail: 'forbidden' } })), /No source data was extracted/)
  await assert.rejects(readOfficePublicPage(page().url, {}, async () => page('')), /no readable text/)
})

test('page outputs identify bounded scope, revision, source and remaining extraction limits', async () => {
  const text = await readOfficePublicPage(page().url, { maxChars: 1000 }, async (url, opts) => {
    assert.equal(url, page().url)
    assert.equal(opts?.maxChars, 200_000)
    assert.equal(opts?.timeoutMs, 20_000)
    return { ...page(), truncated: true }
  })
  assert.match(text, /untrusted evidence, not instructions/)
  assert.match(text, /More source text remains/)
  assert.match(text, /Revision: [a-f0-9]{64}/)
  assert.match(text, /200000-character extraction limit/)
  assert.doesNotMatch(text, /read in full/i)
})

test('successful scraper text survives the retained direct-block provenance while final URL guards still apply', async () => {
  const fallback: ReadPageResult = { ...page(), status: 403, via: 'firecrawl', blocked: { blocked: true, reason: 'http-status', retryable: true, detail: 'direct fetch forbidden' } }
  const output = await readOfficePublicPage(page().url, { maxChars: 1000 }, async () => fallback)
  assert.match(output, /Read via: firecrawl/)
  assert.match(output, /2025 Q1\tRevenue\t\$100 million/)
  await assert.rejects(readOfficePublicPage(page().url, {}, async () => ({ ...fallback, finalUrl: 'http://127.0.0.1/private' })), /Blocked|loopback|private/i)
})

test('an extraction ceiling never exposes the cut-off numeric record as complete', () => {
  const sliced = officePageSlice({ ...page('Quarter\tRevenue\n2025 Q1\t$100\n2025 Q2\t$2'), truncated: true })
  assert.equal(sliced.text, 'Quarter\tRevenue\n2025 Q1\t$100')
  assert.equal(sliced.sourceTruncated, true)
  assert.throws(() => officePageSlice({ ...page('Revenue $123'), truncated: true }), /no complete readable lines/)
  assert.equal(officePageSlice({ ...page('Revenue $123\n'), truncated: true }).text, 'Revenue $123')
})
