import { useMemo, useState, type ReactNode } from 'react'
import { toggleDonePatch, useUpdateTask } from '@/data/tasks'
import { useCalendarEvents } from '@/data/events'
import { cx } from '@/lib/cx'
import { addDays, startOfDay } from '@/lib/dates'
import type { Project, Task, TaskPatch } from '@/lib/types'
import { useToast } from '@/ui/toast'
import {
  buildTimeline,
  dayProgress,
  formatClock,
  formatDayLabel,
  itemPhase,
  nextItemIndex,
  nowLineIndex,
  selectDayGroups,
} from './lib'
import { TaskRow, TimelineRow } from './rows'
import { useNow } from './useNow'

interface Props {
  tasks: Task[]
  projects: Project[]
  connected: boolean
  onOpenCalendar: () => void
}

/**
 * «Сегодня» command center: the day's timeline on the left, the day's debts
 * and wins on the right. Answers "what's now, what's next, what's overdue,
 * how is the day going" without opening the full calendar.
 */
export function TodayView({ tasks, projects, connected, onOpenCalendar }: Props) {
  const now = useNow()
  const dayStart = startOfDay(now)
  const eventsQuery = useCalendarEvents(dayStart, addDays(dayStart, 1), connected)
  const events = useMemo(() => eventsQuery.data ?? [], [eventsQuery.data])

  const update = useUpdateTask()
  const { toast } = useToast()
  const [doneOpen, setDoneOpen] = useState(false)

  const projectById = useMemo(() => new Map(projects.map((p) => [p.id, p])), [projects])
  const timeline = useMemo(() => buildTimeline(tasks, events, now), [tasks, events, now])
  const groups = useMemo(() => selectDayGroups(tasks, now), [tasks, now])
  const progress = dayProgress(groups)

  const lineAt = nowLineIndex(timeline, now)
  const nextAt = nextItemIndex(timeline, now)

  function completeTask(task: Task) {
    // Snapshot the exact prior columns so undo restores them verbatim instead
    // of re-deriving state through toggleDonePatch a second time.
    const revert: TaskPatch = { status: task.status, completed_at: task.completed_at }
    update.mutate({ id: task.id, patch: toggleDonePatch(task) })
    toast({
      message: 'Задача выполнена',
      actionLabel: 'Отменить',
      onAction: () => update.mutate({ id: task.id, patch: revert }),
    })
  }

  function toggleTask(task: Task) {
    if (task.status === 'done') {
      // Un-checking is already the undo — a toast here would just nag.
      update.mutate({ id: task.id, patch: toggleDonePatch(task) })
    } else {
      completeTask(task)
    }
  }

  const timelineRows: ReactNode[] = []
  timeline.forEach((item, i) => {
    if (lineAt === i) timelineRows.push(<NowRule key="now" now={now} />)
    timelineRows.push(
      <TimelineRow
        key={item.id}
        item={item}
        phase={itemPhase(item, now)}
        isNext={nextAt === i}
        project={
          item.kind === 'task' && item.task.project_id
            ? (projectById.get(item.task.project_id) ?? null)
            : null
        }
        onToggleDone={() => item.kind === 'task' && toggleTask(item.task)}
      />,
    )
  })
  if (lineAt === timeline.length) timelineRows.push(<NowRule key="now" now={now} />)

  return (
    <div className="grid items-start gap-4 sm:grid-cols-[minmax(0,7fr)_minmax(0,5fr)]">
      {/* Left — day timeline. First in DOM so it stacks first on mobile. */}
      <section aria-label="Лента дня" className="min-w-0 rounded-card border border-hair bg-surface">
        <h3 className="border-b border-hair px-3 py-2 font-mono text-[0.65rem] tracking-[0.1em] text-muted uppercase">
          Лента дня
        </h3>

        {timeline.length === 0 ? (
          <div className="flex flex-col items-center gap-3 px-4 py-10 text-center">
            <p className="text-sm text-muted">На сегодня ничего не запланировано</p>
            <button
              type="button"
              onClick={onOpenCalendar}
              className="rounded-control border border-rule px-3 py-1.5 text-sm transition-colors hover:bg-sunken"
            >
              Открыть календарь
            </button>
          </div>
        ) : (
          <ul>{timelineRows}</ul>
        )}

        {!connected && (
          <div className="border-t border-hair px-3 py-2">
            <button
              type="button"
              onClick={onOpenCalendar}
              className="text-[0.72rem] text-muted underline decoration-faint underline-offset-2 hover:text-ink"
            >
              События появятся после подключения календаря
            </button>
          </div>
        )}
      </section>

      {/* Right — the day's ledger: header with progress, then the groups. */}
      <div className="flex min-w-0 flex-col gap-4">
        <header className="flex flex-wrap items-end justify-between gap-x-4 gap-y-2 px-1">
          <div>
            <h2 className="font-serif text-2xl font-semibold">Сегодня</h2>
            <p className="mt-0.5 font-mono text-xs text-muted">{formatDayLabel(now)}</p>
          </div>
          {progress.total > 0 && (
            <div className="flex items-center gap-2 pb-1">
              <span className="font-mono text-xs text-muted">
                {progress.done} из {progress.total}
              </span>
              <div className="h-1 w-24 overflow-hidden rounded-block bg-sunken" aria-hidden="true">
                <div
                  className="h-full rounded-block bg-accent transition-[width] duration-300"
                  style={{ width: `${Math.round((progress.done / progress.total) * 100)}%` }}
                />
              </div>
            </div>
          )}
        </header>

        {groups.overdue.length > 0 && (
          <GroupCard
            title="Просрочено"
            count={groups.overdue.length}
            headerClass="text-danger"
          >
            <ul className="divide-y divide-sunken">
              {groups.overdue.map((t) => (
                <TaskRow
                  key={t.id}
                  task={t}
                  project={t.project_id ? (projectById.get(t.project_id) ?? null) : null}
                  dueClass="text-danger"
                  onToggleDone={() => toggleTask(t)}
                />
              ))}
            </ul>
          </GroupCard>
        )}

        <GroupCard title="На сегодня" count={groups.dueToday.length + groups.important.length}>
          {groups.dueToday.length + groups.important.length === 0 ? (
            <p className="px-3 py-3 text-sm text-faint">Нет задач на сегодня</p>
          ) : (
            <ul className="divide-y divide-sunken">
              {groups.dueToday.map((t) => (
                <TaskRow
                  key={t.id}
                  task={t}
                  project={t.project_id ? (projectById.get(t.project_id) ?? null) : null}
                  onToggleDone={() => toggleTask(t)}
                />
              ))}
              {groups.important.length > 0 && (
                <li className="bg-sunken px-3 py-1 font-mono text-[0.62rem] tracking-[0.1em] text-faint uppercase">
                  важное без срока
                </li>
              )}
              {groups.important.map((t) => (
                <TaskRow
                  key={t.id}
                  task={t}
                  project={t.project_id ? (projectById.get(t.project_id) ?? null) : null}
                  onToggleDone={() => toggleTask(t)}
                />
              ))}
            </ul>
          )}
        </GroupCard>

        <section className="rounded-card border border-hair bg-surface">
          <button
            type="button"
            onClick={() => setDoneOpen((v) => !v)}
            aria-expanded={doneOpen}
            className="flex w-full items-center justify-between px-3 py-2 font-mono text-[0.65rem] tracking-[0.1em] text-muted uppercase transition-colors hover:text-ink"
          >
            <span>Сделано сегодня</span>
            <span className="flex items-center gap-2">
              <span className={cx(groups.doneToday.length > 0 && 'text-success')}>
                {groups.doneToday.length}
              </span>
              <span aria-hidden="true">{doneOpen ? '−' : '+'}</span>
            </span>
          </button>
          {doneOpen &&
            (groups.doneToday.length === 0 ? (
              <p className="border-t border-hair px-3 py-3 text-sm text-faint">
                Пока ничего не выполнено
              </p>
            ) : (
              <ul className="divide-y divide-sunken border-t border-hair">
                {groups.doneToday.map((t) => (
                  <TaskRow
                    key={t.id}
                    task={t}
                    project={t.project_id ? (projectById.get(t.project_id) ?? null) : null}
                    onToggleDone={() => toggleTask(t)}
                  />
                ))}
              </ul>
            ))}
        </section>
      </div>
    </div>
  )
}

/** Thin accent rule marking "you are here" between the past and what's ahead. */
function NowRule({ now }: { now: Date }) {
  return (
    <li aria-hidden="true" className="flex items-center gap-2 px-3 py-1">
      <span className="font-mono text-[0.65rem] font-medium text-accent">{formatClock(now)}</span>
      <span className="h-px flex-1 bg-accent/60" />
    </li>
  )
}

function GroupCard({
  title,
  count,
  headerClass,
  children,
}: {
  title: string
  count: number
  headerClass?: string
  children: ReactNode
}) {
  return (
    <section className="rounded-card border border-hair bg-surface">
      <h3
        className={cx(
          'flex items-baseline justify-between border-b border-hair px-3 py-2 font-mono text-[0.65rem] tracking-[0.1em] uppercase',
          headerClass ?? 'text-muted',
        )}
      >
        {title}
        <span>{count}</span>
      </h3>
      {children}
    </section>
  )
}
