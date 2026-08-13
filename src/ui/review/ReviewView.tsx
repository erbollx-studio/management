import { useMemo } from 'react'
import { weeklyStats } from '@/data/stats'
import { useUpdateTask } from '@/data/tasks'
import { cx } from '@/lib/cx'
import { endOfDay, startOfDay } from '@/lib/dates'
import type { Task, TaskPatch } from '@/lib/types'
import { useToast } from '@/ui/toast'

const DAY_MS = 86_400_000

/** Bar height budget in px; the busiest day fills it, the rest scale down. */
const BAR_MAX = 88

const longWeekday = new Intl.DateTimeFormat('ru', { weekday: 'long' })

/**
 * «Обзор» — the weekly review: what got done, what slipped, and how loaded
 * the coming week already is. Everything derives from the tasks array via
 * weeklyStats; the only mutation here is rescheduling an overdue tail.
 */
export function ReviewView({ tasks }: { tasks: Task[] }) {
  const update = useUpdateTask()
  const { toast } = useToast()

  // Single derivation per render: stats and the overdue tail share one memo
  // (and one `now`) so the tiles and the list can never disagree.
  const { stats, tails, todayKey } = useMemo(() => {
    const now = new Date()
    const nowMs = now.getTime()
    const tails = tasks
      .flatMap((t) => {
        if (t.status === 'done' || t.status === 'cancelled' || !t.due_at) return []
        const dueMs = new Date(t.due_at).getTime()
        return dueMs < nowMs ? [{ task: t, dueMs }] : []
      })
      .sort((a, b) => a.dueMs - b.dueMs)
      .slice(0, 5)
    return { stats: weeklyStats(tasks, now), tails, todayKey: startOfDay(now).getTime() }
  }, [tasks])

  const emptyWeek = stats.doneThisWeek === 0
  const maxDone = Math.max(1, ...stats.days.map((d) => d.done))
  const heavyLabel = stats.heavyShare === null ? '—' : `${Math.round(stats.heavyShare * 100)}%`

  function postponeToToday(task: Task) {
    // Snapshot the old due date so undo restores it verbatim.
    const revert: TaskPatch = { due_at: task.due_at }
    update.mutate({ id: task.id, patch: { due_at: endOfDay(new Date()).toISOString() } })
    toast({
      message: 'Перенесено на сегодня',
      actionLabel: 'Отменить',
      onAction: () => update.mutate({ id: task.id, patch: revert }),
    })
  }

  return (
    <div className="flex flex-col gap-4">
      <header className="px-1">
        <h2 className="font-serif text-2xl font-semibold">Обзор</h2>
        <p className="mt-0.5 font-mono text-xs text-muted">последние 7 дней</p>
      </header>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatTile label="Сделано за неделю" value={String(stats.doneThisWeek)} />
        <StatTile
          label="Просрочено сейчас"
          value={String(stats.overdueNow)}
          tone={stats.overdueNow > 0 ? 'danger' : undefined}
        />
        <StatTile label="Запланировано на 7 дней" value={formatHoursMinutes(stats.scheduledMinutesNext7d)} />
        <StatTile label="Тяжёлых в работе" value={heavyLabel} />
      </div>

      <section aria-label="Сделано по дням" className="rounded-card border border-hair bg-surface">
        <h3 className="border-b border-hair px-3 py-2 font-mono text-[0.65rem] tracking-[0.1em] text-muted uppercase">
          Сделано по дням
        </h3>
        {emptyWeek ? (
          <p className="px-4 py-8 text-center text-sm text-muted">
            На этой неделе пока ничего не сделано. Отметьте первую задачу — и здесь появятся столбики.
          </p>
        ) : (
          <div className="flex items-end gap-1.5 px-3 pt-4 pb-2 sm:gap-2.5">
            {stats.days.map((d) => {
              const isToday = d.date.getTime() === todayKey
              const isBest = stats.bestDay !== null && stats.bestDay.date.getTime() === d.date.getTime()
              return (
                <div key={d.date.getTime()} className="flex min-w-0 flex-1 flex-col items-center gap-1">
                  <span
                    className={cx(
                      'font-mono text-[0.68rem] tabular-nums',
                      d.done === 0 ? 'text-faint' : 'text-ink',
                    )}
                  >
                    {d.done}
                  </span>
                  <div
                    className={cx(
                      'w-full max-w-9 rounded-t-[4px]',
                      isToday ? 'bg-accent' : 'border border-b-0 border-hair bg-sunken',
                    )}
                    // +4 keeps a zero day visible as a stub instead of vanishing
                    style={{ height: `${Math.round((d.done / maxDone) * BAR_MAX) + 4}px` }}
                    aria-hidden="true"
                  />
                  <span
                    className={cx(
                      'font-mono text-[0.62rem]',
                      isToday ? 'font-medium text-accent' : 'text-muted',
                    )}
                  >
                    {d.label}
                  </span>
                  <span className="h-3.5 font-mono text-[0.55rem] whitespace-nowrap text-faint">
                    {isBest ? 'лучший день' : ''}
                  </span>
                </div>
              )
            })}
          </div>
        )}
      </section>

      {tails.length > 0 && (
        <section aria-label="Хвосты" className="rounded-card border border-hair bg-surface">
          <h3 className="flex items-baseline justify-between border-b border-hair px-3 py-2 font-mono text-[0.65rem] tracking-[0.1em] text-danger uppercase">
            <span>Хвосты</span>
            <span>{tails.length}</span>
          </h3>
          <ul className="divide-y divide-sunken">
            {tails.map(({ task, dueMs }) => {
              const daysAgo = Math.round((todayKey - startOfDay(new Date(dueMs)).getTime()) / DAY_MS)
              return (
                <li key={task.id} className="flex items-center gap-3 px-3 py-2">
                  <span className="min-w-0 flex-1 truncate text-sm">{task.title}</span>
                  <span className="shrink-0 font-mono text-[0.68rem] tabular-nums text-danger">
                    {daysAgo <= 0 ? 'сегодня' : `${daysAgo} дн. назад`}
                  </span>
                  <button
                    type="button"
                    onClick={() => postponeToToday(task)}
                    className="shrink-0 rounded-control border border-rule px-2.5 py-1 font-mono text-[0.7rem] transition-colors hover:border-accent"
                  >
                    Сегодня
                  </button>
                </li>
              )
            })}
          </ul>
        </section>
      )}

      {!emptyWeek && (
        <p className="px-1 pb-2 font-serif text-sm text-muted italic">
          За неделю {doneVerb(stats.doneThisWeek)} {stats.doneThisWeek} {taskNoun(stats.doneThisWeek)}.
          {stats.bestDay !== null && ` Лучший день — ${longWeekday.format(stats.bestDay.date)}.`}
        </p>
      )}
    </div>
  )
}

function StatTile({ label, value, tone }: { label: string; value: string; tone?: 'danger' }) {
  return (
    <div className="rounded-card border border-hair bg-surface px-3 py-2.5">
      <p className="font-mono text-[0.62rem] tracking-[0.1em] text-muted uppercase">{label}</p>
      <p className={cx('mt-1 font-serif text-2xl font-semibold tabular-nums', tone === 'danger' && 'text-danger')}>
        {value}
      </p>
    </div>
  )
}

/** «N ч M м» for the scheduled-time tile; zero reads as «0 м». */
function formatHoursMinutes(minutes: number): string {
  const h = Math.floor(minutes / 60)
  const m = minutes % 60
  if (h === 0) return `${m} м`
  return m > 0 ? `${h} ч ${m} м` : `${h} ч`
}

/** Russian plural: 1 задача · 2 задачи · 5 задач. */
function taskNoun(n: number): string {
  const mod10 = n % 10
  const mod100 = n % 100
  if (mod10 === 1 && mod100 !== 11) return 'задача'
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return 'задачи'
  return 'задач'
}

/** The verb agrees with the noun: «сделана 21 задача», «сделано 5 задач». */
function doneVerb(n: number): string {
  return n % 10 === 1 && n % 100 !== 11 ? 'сделана' : 'сделано'
}
