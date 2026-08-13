import { useEffect, useRef } from 'react'
import { Draggable } from '@fullcalendar/interaction'
import { cx } from '@/lib/cx'
import { formatDueDate, formatEstimate, isOverdue } from '@/lib/dates'
import { sortTasks } from '@/lib/views'
import type { Task } from '@/lib/types'

/**
 * Unscheduled tasks waiting to be dragged onto the grid. FullCalendar reads the
 * drag itself; we only mark the items and stash the task id in data attributes.
 */
export function TaskTray({ tasks }: { tasks: Task[] }) {
  const containerRef = useRef<HTMLDivElement>(null)
  const inbox = sortTasks(tasks.filter((t) => t.status === 'inbox'))

  useEffect(() => {
    if (!containerRef.current) return
    // `create: false` keeps FullCalendar from painting a ghost event on drop —
    // the grid's `drop` handler writes the task and the mirror renders the
    // real event once the refresh lands.
    const draggable = new Draggable(containerRef.current, {
      itemSelector: '[data-task-id]',
      eventData: () => ({ create: false }),
    })
    return () => draggable.destroy()
  }, [])

  return (
    <div ref={containerRef} className="overflow-hidden rounded-card border border-hair bg-surface">
      <p className="border-b border-hair px-3 py-1.5 font-mono text-[0.65rem] tracking-[0.12em] text-muted uppercase">
        Незапланированные
      </p>
      {inbox.length === 0 ? (
        <p className="px-3 py-2 text-sm text-faint">Все задачи запланированы.</p>
      ) : (
        <ul className="flex flex-wrap gap-1.5 px-3 py-2">
          {inbox.map((t) => (
            <li
              key={t.id}
              data-task-id={t.id}
              data-estimate={t.estimate_minutes ?? ''}
              className="flex max-w-full cursor-grab items-baseline gap-2 rounded-block border-l-[3px] border-accent bg-accent-soft px-2 py-1 text-[0.8rem] font-medium select-none active:cursor-grabbing"
            >
              <span className="min-w-0 truncate">{t.title}</span>
              <span className="flex shrink-0 items-baseline gap-2 font-mono text-[0.66rem] text-muted">
                {t.estimate_minutes ? <span>{formatEstimate(t.estimate_minutes)}</span> : null}
                {t.due_at && (
                  <span className={cx(isOverdue(t.due_at) && 'text-danger')}>{formatDueDate(t.due_at)}</span>
                )}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
