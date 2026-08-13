import { useEffect, useRef } from 'react'
import { useCalendars, useDisconnectGoogle } from '@/data/calendar'
import type { GoogleAccount } from '@/lib/types'

/**
 * Right-side sheet with the connection plumbing — account, disconnect, the
 * calendar list. Lives behind a «Настройки» button so the calendar page stays
 * a working desk; broken-connection states are rendered inline by the panel
 * instead, where they cannot be missed.
 */
export function SettingsSheet({ account, onClose }: { account: GoogleAccount; onClose: () => void }) {
  const sheetRef = useRef<HTMLDivElement>(null)
  const disconnect = useDisconnectGoogle()
  const connected = account.status === 'connected'
  const calendars = useCalendars(connected)

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

  return (
    <div className="fixed inset-0 z-50 flex justify-end" onKeyDown={handleKeyDown}>
      {/* Scrim: plain black at low alpha reads correctly over both themes. */}
      <div aria-hidden="true" className="absolute inset-0 bg-black/40" onClick={onClose} />

      <div
        ref={sheetRef}
        role="dialog"
        aria-modal="true"
        aria-label="Настройки календаря"
        tabIndex={-1}
        className="relative flex h-full w-full max-w-sm flex-col overflow-y-auto border-l border-hair bg-surface focus:outline-none"
      >
        <div className="flex items-center justify-between gap-3 border-b border-hair px-4 py-3">
          <h2 className="font-serif text-lg font-semibold">Настройки календаря</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Закрыть"
            className="rounded-control px-1.5 py-0.5 font-mono text-xs text-faint transition-colors hover:text-ink"
          >
            ✕
          </button>
        </div>

        <div className="flex flex-wrap items-start justify-between gap-3 border-b border-hair px-4 py-3">
          <div className="min-w-0">
            <p className="font-mono text-[0.68rem] tracking-[0.12em] text-muted uppercase">
              {connected ? 'Подключено' : 'Требуется повторный вход'}
            </p>
            <p className="mt-1 truncate text-sm">{account.email ?? 'аккаунт Google'}</p>
            <p className="mt-0.5 font-mono text-[0.68rem] text-faint">
              с {new Date(account.connected_at).toLocaleDateString('ru')}
            </p>
          </div>
          <button
            type="button"
            onClick={() => disconnect.mutate(undefined, { onSuccess: onClose })}
            disabled={disconnect.isPending}
            className="shrink-0 rounded-control border border-rule px-2.5 py-1 font-mono text-[0.7rem] text-danger transition-colors hover:border-danger disabled:opacity-50"
          >
            Отключить
          </button>
        </div>

        <div className="px-4 py-3">
          <h3 className="font-mono text-[0.65rem] tracking-[0.12em] text-muted uppercase">Календари</h3>
          {!connected && (
            <p className="mt-2 text-sm text-faint">Список появится после повторного входа.</p>
          )}
          {calendars.isLoading && <p className="mt-2 text-sm text-faint">Загружаем…</p>}
          {calendars.error && (
            <p className="mt-2 text-sm text-danger">
              Не удалось получить список: {calendars.error.message}
            </p>
          )}
          {calendars.data && (
            <ul className="mt-2 flex flex-col gap-1.5">
              {calendars.data.map((c) => (
                <li key={c.id} className="flex items-center gap-2 text-sm">
                  <span
                    className="size-2 shrink-0 rounded-full"
                    style={{ background: c.backgroundColor ?? 'var(--c-rule)' }}
                    aria-hidden="true"
                  />
                  <span className="min-w-0 flex-1 truncate">{c.summary}</span>
                  {c.primary && (
                    <span className="shrink-0 font-mono text-[0.62rem] tracking-wider text-faint uppercase">
                      основной
                    </span>
                  )}
                </li>
              ))}
              {calendars.data.length === 0 && (
                <li className="text-sm text-faint">Календарей с правом записи не найдено.</li>
              )}
            </ul>
          )}
        </div>
      </div>
    </div>
  )
}
