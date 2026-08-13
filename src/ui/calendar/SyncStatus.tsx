import { useEffect, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { EVENTS_KEY, useSyncNow } from '@/data/events'
import { cx } from '@/lib/cx'

/** The server cron keeps the mirror fresh; the client only re-reads it. */
const AUTO_REFRESH_MS = 5 * 60_000

function formatAgo(from: Date, now: Date): string {
  const min = Math.max(0, Math.floor((now.getTime() - from.getTime()) / 60_000))
  if (min < 1) return 'обновлено только что'
  if (min < 60) return `обновлено ${min} мин назад`
  return `обновлено ${Math.floor(min / 60)} ч назад`
}

/**
 * Quiet sync corner: a mono "updated N min ago" note plus a ↻ glyph for an
 * on-demand pull. No big button — syncing is background plumbing, not a task.
 */
export function SyncStatus() {
  const qc = useQueryClient()
  const sync = useSyncNow()
  // Local only: "last successful manual pull", not persisted — before the
  // first one there is simply nothing to claim.
  const [lastSyncAt, setLastSyncAt] = useState<Date | null>(null)
  const [now, setNow] = useState(() => new Date())

  // Re-render once a minute so the "N мин назад" label stays honest.
  useEffect(() => {
    const id = window.setInterval(() => setNow(new Date()), 60_000)
    return () => window.clearInterval(id)
  }, [])

  // Periodic re-read of the mirror; invalidation makes the visible window
  // refetch whatever the server cron has already pulled in.
  useEffect(() => {
    const id = window.setInterval(
      () => qc.invalidateQueries({ queryKey: EVENTS_KEY }),
      AUTO_REFRESH_MS,
    )
    return () => window.clearInterval(id)
  }, [qc])

  return (
    <span className="flex min-w-0 items-center gap-2 font-mono text-[0.66rem] text-faint">
      <button
        type="button"
        onClick={() => sync.mutate(undefined, { onSuccess: () => setLastSyncAt(new Date()) })}
        disabled={sync.isPending}
        aria-label="Синхронизировать"
        title="Синхронизировать"
        className="rounded-control px-1 py-0.5 text-sm leading-none text-muted transition-colors hover:text-ink disabled:opacity-50"
      >
        <span aria-hidden="true" className={cx('inline-block', sync.isPending && 'animate-spin')}>
          ↻
        </span>
      </button>
      {sync.isPending ? (
        <span>синхронизация…</span>
      ) : sync.error ? (
        <span className="truncate text-danger">не удалось обновить</span>
      ) : lastSyncAt ? (
        <span className="truncate">{formatAgo(lastSyncAt, now)}</span>
      ) : null}
    </span>
  )
}
