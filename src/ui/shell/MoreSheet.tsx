import { useEffect, useRef } from 'react'
import { useProjects } from '@/data/projects'
import { cx } from '@/lib/cx'
import { viewKey, type View } from '@/lib/views'

/* Views that did not fit on the tab bar; projects follow below. */
const EXTRA_VIEWS: Array<{ view: View; label: string }> = [
  { view: { kind: 'upcoming' }, label: 'Предстоящие' },
  { view: { kind: 'inbox' }, label: 'Входящие' },
  { view: { kind: 'done' }, label: 'Выполненные' },
]

interface Props {
  current: View
  onSelect: (view: View) => void
  onClose: () => void
}

export function MoreSheet({ current, onSelect, onClose }: Props) {
  const { data: projects = [] } = useProjects()
  const sheetRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    // Move focus into the dialog and hand it back to the opener on close, so
    // keyboard users are not stranded behind an aria-modal surface.
    const opener = document.activeElement as HTMLElement | null
    sheetRef.current?.focus()
    // Freeze the page behind the sheet — it is a modal, not an overlay panel.
    const prevOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      document.body.style.overflow = prevOverflow
      opener?.focus()
    }
  }, [])

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Escape') {
      e.stopPropagation()
      onClose()
      return
    }
    if (e.key !== 'Tab') return
    // Minimal focus trap: aria-modal promises focus stays inside.
    const sheet = sheetRef.current
    if (!sheet) return
    const focusables = sheet.querySelectorAll<HTMLElement>('button, [href], [tabindex]:not([tabindex="-1"])')
    const first = focusables[0]
    const last = focusables[focusables.length - 1]
    if (!first || !last) return
    if (e.shiftKey && (document.activeElement === first || document.activeElement === sheet)) {
      e.preventDefault()
      last.focus()
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault()
      first.focus()
    }
  }

  const activeKey = viewKey(current)

  function pick(view: View) {
    onSelect(view)
    onClose()
  }

  return (
    <div className="fixed inset-0 z-50 flex flex-col justify-end sm:hidden" onKeyDown={handleKeyDown}>
      {/* Scrim: plain black at low alpha reads correctly over both themes. */}
      <div aria-hidden="true" className="absolute inset-0 bg-black/40" onClick={onClose} />

      <div
        ref={sheetRef}
        role="dialog"
        aria-modal="true"
        aria-label="Ещё"
        tabIndex={-1}
        className="relative max-h-[75vh] overflow-y-auto rounded-t-card border-t border-hair bg-surface px-4 pt-3 pb-[calc(1rem+env(safe-area-inset-bottom))] focus:outline-none"
      >
        <div className="mx-auto mb-3 h-1 w-9 rounded-full bg-rule" aria-hidden="true" />

        <ul className="flex flex-col">
          {EXTRA_VIEWS.map(({ view, label }) => (
            <li key={viewKey(view)}>
              <SheetButton active={viewKey(view) === activeKey} onClick={() => pick(view)}>
                {label}
              </SheetButton>
            </li>
          ))}
        </ul>

        <h2 className="mt-4 mb-1 px-2.5 font-mono text-[0.65rem] tracking-[0.14em] text-faint uppercase">
          Проекты
        </h2>
        <ul className="flex flex-col">
          {projects.map((p) => {
            const view: View = { kind: 'project', id: p.id }
            return (
              <li key={p.id}>
                <SheetButton active={viewKey(view) === activeKey} onClick={() => pick(view)}>
                  <span className="size-2 shrink-0 rounded-full" style={{ background: p.color }} aria-hidden="true" />
                  <span className="min-w-0 flex-1 truncate">{p.name}</span>
                </SheetButton>
              </li>
            )
          })}
          {projects.length === 0 && <li className="px-2.5 py-2 text-sm text-faint">Пока нет проектов</li>}
        </ul>
      </div>
    </div>
  )
}

function SheetButton({
  active,
  onClick,
  children,
}: {
  active: boolean
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={active ? 'page' : undefined}
      className={cx(
        'flex w-full items-center gap-2 rounded-control px-2.5 py-2 text-left text-sm transition-colors',
        active ? 'bg-sunken font-medium text-ink' : 'text-muted hover:text-ink',
      )}
    >
      {children}
    </button>
  )
}
