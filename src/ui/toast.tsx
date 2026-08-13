import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from 'react'
import { cx } from '@/lib/cx'

/**
 * Minimal toast layer shared by every feature that needs "done + undo".
 * Deliberately tiny: no queue juggling, newest replaces oldest beyond 3,
 * an optional action button, auto-dismiss after 5s.
 */

export interface Toast {
  id: number
  message: string
  actionLabel?: string
  onAction?: () => void
  tone?: 'default' | 'danger'
}

interface ToastApi {
  toast: (t: Omit<Toast, 'id'>) => void
}

const ToastContext = createContext<ToastApi | null>(null)

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<Toast[]>([])
  const nextId = useRef(1)

  const dismiss = useCallback((id: number) => {
    setItems((list) => list.filter((t) => t.id !== id))
  }, [])

  const toast = useCallback(
    (t: Omit<Toast, 'id'>) => {
      const id = nextId.current++
      setItems((list) => [...list.slice(-2), { ...t, id }])
      window.setTimeout(() => dismiss(id), 5000)
    },
    [dismiss],
  )

  const api = useMemo(() => ({ toast }), [toast])

  return (
    <ToastContext value={api}>
      {children}
      <div
        aria-live="polite"
        className="pointer-events-none fixed inset-x-0 bottom-4 z-50 flex flex-col items-center gap-2 px-4"
      >
        {items.map((t) => (
          <div
            key={t.id}
            className={cx(
              'pointer-events-auto flex w-full max-w-sm items-center justify-between gap-3 rounded-control border bg-surface px-3.5 py-2.5 text-sm shadow-[0_4px_16px_rgb(0_0_0/0.08)]',
              t.tone === 'danger' ? 'border-danger/50' : 'border-hair',
            )}
          >
            <span className="min-w-0 flex-1">{t.message}</span>
            {t.actionLabel && (
              <button
                type="button"
                onClick={() => {
                  t.onAction?.()
                  dismiss(t.id)
                }}
                className="shrink-0 font-medium text-accent hover:underline"
              >
                {t.actionLabel}
              </button>
            )}
            <button
              type="button"
              onClick={() => dismiss(t.id)}
              aria-label="Закрыть"
              className="shrink-0 font-mono text-xs text-faint hover:text-ink"
            >
              ✕
            </button>
          </div>
        ))}
      </div>
    </ToastContext>
  )
}

export function useToast(): ToastApi {
  const ctx = useContext(ToastContext)
  if (!ctx) throw new Error('useToast must be used inside <ToastProvider>')
  return ctx
}
