import { Markdown, type MarkdownNav } from './Markdown'

const RECOVERY_PREFIX = '[Task interrupted — not completed]\n'

/** Presentation only: the original checkpoint remains intact for persistence,
 * copy actions and model restoration. Never interpret a user message as one. */
export function AssistantMessage({ text, role = 'assistant', nav }: {
  text: string
  role?: 'user' | 'assistant'
  nav?: MarkdownNav
}) {
  if (role !== 'assistant' || !text.startsWith(RECOVERY_PREFIX)) return <Markdown text={text} nav={nav} />
  const firstLine = text.slice(RECOVERY_PREFIX.length).split('\n', 1)[0] ?? ''
  const reason = firstLine.startsWith('Reason: ') ? firstLine.slice(8).trim() : ''
  const briefReason = reason.length > 280 ? reason.slice(0, 280) + '…' : reason
  return <section className="sw-agent-recovery" aria-label="Interrupted task">
    <p><strong>Task interrupted.</strong> The earlier task context is retained. Review the current document before continuing.</p>
    {briefReason && <p>{briefReason}</p>}
    <details>
      <summary>Recovery details</summary>
      <div style={{ maxHeight: '20rem', overflow: 'auto', overflowWrap: 'anywhere' }}>
        <Markdown text={text} nav={nav} />
      </div>
    </details>
  </section>
}
