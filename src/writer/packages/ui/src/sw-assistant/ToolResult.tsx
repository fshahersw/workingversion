import { Markdown } from '../Markdown'
import { safeAssistantImage, safeAssistantLink } from '../safe-links'
import type { Activity } from './core'

/** UI side channel only. Never fetch or execute URLs embedded in tool output. */
export function ToolResult({ display }: { display?: Activity['display'] }) {
  if (!display || typeof display !== 'object') return null
  if (display.kind === 'text') return typeof display.text === 'string' && display.text ? <div className="sw-agent-result"><Markdown text={display.text.slice(0, 12000)} /></div> : null
  if (!['images', 'links'].includes(display.kind) || !Array.isArray(display.items)) return null
  return <div className="sw-agent-result" aria-label="Tool results">{display.items.slice(0, 12).map((item, index) => {
    if (!item || typeof item !== 'object' || typeof item.url !== 'string') return null
    const title = typeof item.title === 'string' ? item.title : undefined
    if (display.kind === 'images' && safeAssistantImage(item.url)) return <figure key={index}><img src={item.url} alt={title ?? 'Tool preview'} loading="lazy" /><figcaption>{title ?? 'Preview'}</figcaption></figure>
    const link = safeAssistantLink(item.url)
    if (!link) return null
    return <a key={index} className="sw-agent-result-link" href={link.href} target={link.external ? '_blank' : undefined} rel={link.external ? 'noopener noreferrer' : undefined}><span>{title || (link.external ? new URL(link.href).hostname : 'Open document')}</span><small>{link.external ? 'Open source ↗' : 'Open document →'}</small></a>
  })}</div>
}
