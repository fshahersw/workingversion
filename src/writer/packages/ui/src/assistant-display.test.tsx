import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import { renderToStaticMarkup } from 'react-dom/server'
import { Markdown } from './Markdown'
import { ToolResult } from './sw-assistant/ToolResult'
import { activityDuration, safeAssistantImage, safeAssistantLink } from './safe-links'

describe('untrusted assistant display', () => {
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
