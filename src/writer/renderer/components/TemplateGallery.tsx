import { useEffect, useRef, useState } from 'react'

type TemplateItem = { id: string; name: string; category: string; source: string }

/**
 * Ribbon dropdown that lists firm + user-saved document templates and applies
 * the picked one. It reuses the already-wired `apply_template` tool through a
 * natural-language preset (via `onPick` -> the assistant), so there is no new
 * tool surface and no allow-list change. Self-contained (own open state, fetch,
 * outside-click close, inline styles) to avoid touching the shared ribbon state.
 */
export function TemplateGallery({
  kind,
  onPick,
  disabled,
}: {
  kind: 'docx' | 'xlsx' | 'pptx'
  onPick: (id: string) => void
  disabled?: boolean
}) {
  const [open, setOpen] = useState(false)
  const [items, setItems] = useState<TemplateItem[]>([])
  const [loading, setLoading] = useState(false)
  const [loaded, setLoaded] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)

  // Fetch once, lazily, the first time the menu opens.
  useEffect(() => {
    if (!open || loaded || loading) return
    setLoading(true)
    void (async () => {
      try {
        const mod = await import('@/lib/office/tools.functions')
        const res = await mod.officeListTemplatesFn({ data: { kind } })
        setItems(
          (res.templates ?? []).map((tpl) => ({
            id: String(tpl.id),
            name: String(tpl.name),
            category: String(tpl.category ?? ''),
            source: String(tpl.source ?? 'firm'),
          })),
        )
      } catch {
        setItems([])
      } finally {
        setLoading(false)
        setLoaded(true)
      }
    })()
  }, [open, loaded, loading, kind])

  // Close on outside click.
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [open])

  const grouped = items.reduce<Record<string, TemplateItem[]>>((acc, it) => {
    const key = it.category || 'Other'
    ;(acc[key] ??= []).push(it)
    return acc
  }, {})

  return (
    <div ref={rootRef} style={{ position: 'relative', display: 'inline-flex' }}>
      <button
        className="rb-big ai-entry"
        disabled={disabled}
        data-tip="Insert a firm template"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="rb-big-icon">
          <span className="ai-feature-icon" aria-hidden="true">
            <svg
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <rect x="4" y="3" width="16" height="18" rx="1.5" />
              <path d="M8 7h8" />
              <path d="M8 11h8" />
              <path d="M8 15h5" />
            </svg>
          </span>
        </span>
        <span>Templates</span>
      </button>
      {open && (
        <div
          role="menu"
          data-rb-panel=""
          style={{
            position: 'absolute',
            top: '100%',
            left: 0,
            zIndex: 60,
            minWidth: 248,
            maxHeight: 360,
            overflowY: 'auto',
            background: 'var(--rb-menu-bg, #ffffff)',
            border: '1px solid var(--rb-menu-border, #d5d7db)',
            borderRadius: 8,
            boxShadow: '0 8px 24px rgba(0, 0, 0, 0.16)',
            padding: 6,
            textAlign: 'left',
          }}
        >
          {loading && <div style={{ padding: '8px 10px', opacity: 0.7 }}>Loading…</div>}
          {!loading && items.length === 0 && (
            <div style={{ padding: '8px 10px', opacity: 0.7 }}>No templates found</div>
          )}
          {Object.entries(grouped).map(([cat, list]) => (
            <div key={cat}>
              <div
                style={{
                  padding: '6px 10px 2px',
                  fontSize: 11,
                  opacity: 0.55,
                  textTransform: 'uppercase',
                  letterSpacing: 0.4,
                }}
              >
                {cat}
              </div>
              {list.map((it) => (
                <button
                  key={it.id}
                  role="menuitem"
                  onClick={() => {
                    setOpen(false)
                    onPick(it.id)
                  }}
                  style={{
                    display: 'block',
                    width: '100%',
                    textAlign: 'left',
                    padding: '6px 10px',
                    background: 'none',
                    border: 'none',
                    borderRadius: 6,
                    cursor: 'pointer',
                    fontSize: 13,
                    color: 'inherit',
                  }}
                  title={it.source === 'firm' ? 'Firm template' : 'Your saved template'}
                >
                  {it.name}
                  {it.source !== 'firm' ? ' •' : ''}
                </button>
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
