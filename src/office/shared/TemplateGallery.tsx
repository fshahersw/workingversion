import { useEffect, useRef, useState } from 'react'

type TemplateItem = { id: string; name: string; category: string; source: string }

/**
 * Shared ribbon dropdown that lists firm + user-saved templates and applies the
 * picked one. Reuses the already-wired `apply_template` tool through a
 * natural-language preset (via `onPick`) — no new tool surface, no allow-list
 * change. Used by Writer, Slides (and Sheets) ribbons; `triggerClassName` lets
 * each shell style the button natively.
 *
 * The popover is `position: fixed` and anchored to the button rect on open,
 * because the ribbon body is `overflow-y: hidden` and would clip a normally
 * flowed dropdown (same reason the built-in ribbon popovers are fixed +
 * JS-anchored). Self-contained state; closes on outside click / scroll / resize.
 */
export function TemplateGallery({
  kind,
  onPick,
  disabled,
  triggerClassName = 'rb-big ai-entry',
  label = 'Templates',
}: {
  kind: 'docx' | 'xlsx' | 'pptx'
  onPick: (id: string) => void
  disabled?: boolean
  triggerClassName?: string
  label?: string
}) {
  const [open, setOpen] = useState(false)
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null)
  const [items, setItems] = useState<TemplateItem[]>([])
  const [loading, setLoading] = useState(false)
  const [loaded, setLoaded] = useState(false)
  const rootRef = useRef<HTMLDivElement>(null)

  const PANEL_WIDTH = 260

  const anchor = () => {
    const r = rootRef.current?.getBoundingClientRect()
    if (!r) return
    const left = Math.max(8, Math.min(r.left, window.innerWidth - PANEL_WIDTH - 8))
    setPos({ top: Math.round(r.bottom + 4), left: Math.round(left) })
  }

  const toggle = () => {
    if (open) {
      setOpen(false)
      return
    }
    anchor()
    setOpen(true)
  }

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

  // Close on outside click; close on scroll/resize (the fixed popover would detach).
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false)
    }
    const onLeave = () => setOpen(false)
    document.addEventListener('mousedown', onDown)
    window.addEventListener('resize', onLeave)
    window.addEventListener('scroll', onLeave, true)
    return () => {
      document.removeEventListener('mousedown', onDown)
      window.removeEventListener('resize', onLeave)
      window.removeEventListener('scroll', onLeave, true)
    }
  }, [open])

  const grouped = items.reduce<Record<string, TemplateItem[]>>((acc, it) => {
    const key = it.category || 'Other'
    ;(acc[key] ??= []).push(it)
    return acc
  }, {})

  return (
    <div ref={rootRef} style={{ position: 'relative', display: 'inline-flex' }}>
      <button
        className={triggerClassName}
        disabled={disabled}
        data-tip="Insert a firm template"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={toggle}
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
        <span>{label}</span>
      </button>
      {open && pos && (
        <div
          role="menu"
          style={{
            position: 'fixed',
            top: pos.top,
            left: pos.left,
            zIndex: 2000,
            width: PANEL_WIDTH,
            maxHeight: 380,
            overflowY: 'auto',
            display: 'block',
            background: 'var(--sw-white, #ffffff)',
            color: 'var(--sw-ink, #1a1a1a)',
            border: '1px solid var(--sw-line, #d5d7db)',
            borderRadius: 8,
            boxShadow: '0 10px 30px rgba(0, 0, 0, 0.18)',
            padding: 6,
            textAlign: 'left',
            font: "13px/1.4 'Segoe UI', Arial, sans-serif",
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
                  onMouseEnter={(e) => (e.currentTarget.style.background = 'var(--sw-subtle, #eef1f4)')}
                  onMouseLeave={(e) => (e.currentTarget.style.background = 'none')}
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
