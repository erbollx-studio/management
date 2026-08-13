import { cx } from '@/lib/cx'
import type { View } from '@/lib/views'

/* Views reachable directly from the tab bar; everything else lives behind
   «Ещё», so that tab lights up whenever the current view is not a direct one. */
const DIRECT_KINDS = ['today', 'all', 'calendar'] as const

const TABS: Array<{ view: View; label: string }> = [
  { view: { kind: 'today' }, label: 'Сегодня' },
  { view: { kind: 'all' }, label: 'Задачи' },
  { view: { kind: 'calendar' }, label: 'Календарь' },
]

interface Props {
  current: View
  onSelect: (view: View) => void
  onMore: () => void
  moreOpen: boolean
}

export function TabBar({ current, onSelect, onMore, moreOpen }: Props) {
  const moreActive = !DIRECT_KINDS.includes(current.kind as (typeof DIRECT_KINDS)[number])

  return (
    <nav
      aria-label="Основные разделы"
      className="fixed inset-x-0 bottom-0 z-40 border-t border-hair bg-surface pb-[env(safe-area-inset-bottom)] sm:hidden"
    >
      <div className="grid grid-cols-4">
        {TABS.map(({ view, label }) => {
          const active = current.kind === view.kind
          return (
            <TabButton
              key={view.kind}
              label={label}
              active={active}
              onClick={() => onSelect(view)}
              ariaCurrent={active ? 'page' : undefined}
            />
          )
        })}
        <TabButton
          label="Ещё"
          active={moreActive}
          onClick={onMore}
          ariaExpanded={moreOpen}
          ariaHaspopup="dialog"
        />
      </div>
    </nav>
  )
}

function TabButton({
  label,
  active,
  onClick,
  ariaCurrent,
  ariaExpanded,
  ariaHaspopup,
}: {
  label: string
  active: boolean
  onClick: () => void
  ariaCurrent?: 'page'
  ariaExpanded?: boolean
  ariaHaspopup?: 'dialog'
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={ariaCurrent}
      aria-expanded={ariaExpanded}
      aria-haspopup={ariaHaspopup}
      className={cx(
        // Transparent top border on inactive tabs keeps heights equal — no shift.
        'border-t-2 px-1 pt-2.5 pb-2 text-center font-mono text-[0.62rem] tracking-[0.12em] uppercase transition-colors',
        active ? 'border-accent text-ink' : 'border-transparent text-muted hover:text-ink',
      )}
    >
      {label}
    </button>
  )
}
