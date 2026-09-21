import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { renderToStaticMarkup } from 'react-dom/server'
import { Markdown } from './Markdown'
import { ToolResult } from './sw-assistant/ToolResult'
import { activityDuration, safeAssistantImage, safeAssistantLink } from './safe-links'
import { activityStatus, summarizeActivities } from './sw-assistant/core'
import { AssistantActivity } from './sw-assistant/Assistant'
import { AssistantMessage } from './AssistantMessage'

describe('untrusted assistant display', () => {
  test('exact assistant recovery checkpoints collapse without discarding full content or interpreting user text', () => {
    const receipt = 'Historical receipt '.repeat(800) + 'END_OF_ORIGINAL_CHECKPOINT'
    const text = '[Task interrupted — not completed]\nReason: ' + '<script>untrusted</script>'.repeat(20) + '\n' + receipt
    const html = renderToStaticMarkup(<AssistantMessage text={text} />)
    const detailsStart = html.indexOf('<details>')
    assert.ok(detailsStart > 0)
    assert.doesNotMatch(html, /<details[^>]*\bopen/)
    assert.match(html, /<summary>Recovery details<\/summary>/)
    assert.doesNotMatch(html.slice(0, detailsStart), /Historical receipt/)
    assert.match(html.slice(detailsStart), /END_OF_ORIGINAL_CHECKPOINT/)
    assert.match(html, /max-height:20rem;overflow:auto/)
    assert.doesNotMatch(html, /<script>/)
    assert.ok(html.slice(0, detailsStart).length < 1000, 'visible reason must stay bounded')
    assert.match(text, /END_OF_ORIGINAL_CHECKPOINT$/, 'the input used for persistence/restoration stays intact')
    const user = renderToStaticMarkup(<AssistantMessage role="user" text={text} />)
    assert.doesNotMatch(user, /Recovery details|<details/)
    const ordinary = '**Normal answer** with [source](https://example.org/report)'
    assert.equal(renderToStaticMarkup(<AssistantMessage text={ordinary} />), renderToStaticMarkup(<Markdown text={ordinary} />))
    assert.doesNotMatch(renderToStaticMarkup(<AssistantMessage text={'Quoted marker: ' + text} />), /Recovery details|<details/)
  })
  test('deliberately skipped actions stay distinct from failures and stops in rendered activity', () => {
    const tools = [{ name: 'read_range', summary: 'Read cells' },
      { name: 'run_python', summary: 'Skipped after updated directions', skipped: true, isError: true }]
    assert.equal(activityStatus(tools[1]!), 'skipped')
    const summary = summarizeActivities(tools)
    assert.equal(summary.failed, 0)
    assert.equal(summary.stopped, 0)
    assert.equal(summary.skipped, 1)
    assert.match(summary.label, /1 completed · 1 skipped/)
    const html = renderToStaticMarkup(<AssistantActivity tools={tools} />)
    assert.match(html, /Skipped/)
    assert.doesNotMatch(html, /Failed|Stopped|failed|Stopped before/)
    assert.equal(activityStatus({ summary: 'Actual error', isError: true }), 'failed')
  })
  test('renders a citation and refuses script, credentials and ambiguous path URLs', () => {
    const html = renderToStaticMarkup(<Markdown text={'[Source](https://example.org/report) [Bad](javascript:alert) [Secret](https://user:pass@example.org/)'} />)
    assert.match(html, /href="https:\/\/example.org\/report"/)
    assert.match(html, /rel="noopener noreferrer"/)
    assert.doesNotMatch(html, /href="(?:javascript:|https:\/\/user:pass)/)
    for (const value of ['//example.org', 'https://example.org\\@evil.org', 'data:text/html;base64,PHNjcmlwdD4=', 'https://a.example/\nq']) assert.equal(safeAssistantLink(value), null)
  })
  test('renders only raster data previews and safe source links', () => {
    assert.equal(safeAssistantImage('data:image/svg+xml;base64,PHN2Zz4='), false)
    assert.equal(safeAssistantImage('https://example.org/tracker.png'), false)
    const html = renderToStaticMarkup(<ToolResult display={{ kind: 'images', items: [
      { url: 'data:image/png;base64,iVBORw0KGgo=', title: '<script>Preview</script>' },
      { url: 'javascript:alert(1)', title: 'bad' },
      { url: 'https://example.org/figure.png', title: 'Remote figure' },
    ] }} />)
    assert.match(html, /&lt;script&gt;Preview/)
    assert.doesNotMatch(html, /src="https:|javascript:/)
    assert.match(html, /Open source/)
  })
  test('preserves workspace navigation and rejects nonsensical timing', () => {
    assert.deepEqual(safeAssistantLink('/office/pdf/01ARZ3NDEKTSV4RRFFQ69G5FAV'), { href: '/office/pdf/01ARZ3NDEKTSV4RRFFQ69G5FAV', external: false })
    assert.equal(activityDuration(1000, 1875), '875 ms')
    assert.equal(activityDuration(1000, 0), null)
    assert.equal(activityDuration(undefined, 10), null)
    const path = '/office/drafts/01ARZ3NDEKTSV4RRFFQ69G5FAV'
    assert.deepEqual(safeAssistantLink('http://127.0.0.1:5189' + path, 'http://127.0.0.1:5189'), { href: path, external: false })
    assert.equal(safeAssistantLink('http://127.0.0.1:5190' + path, 'http://127.0.0.1:5189'), null)
    assert.equal(safeAssistantLink({ url: 'https://example.org' }), null)
    assert.equal(safeAssistantImage(undefined), false)
  })
  test('malformed tool side channels do not crash the conversation', () => {
    for (const display of [{kind:'images', items: {}}, {kind:'text', text:{}}, {kind:'links', items:[null, {}, {url:44}, {url:'https://example.org',title:{}}]}]) {
      assert.doesNotThrow(() => renderToStaticMarkup(<ToolResult display={display as never} />))
    }
  })
})
