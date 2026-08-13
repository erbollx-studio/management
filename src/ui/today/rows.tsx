import { cx } from '@/lib/cx'
import { formatDueDate } from '@/lib/dates'
import type { Project, Task } from '@/lib/types'
import { formatTimeRange, type Phase, type TimelineItem } from './lib'

/** Same anatomy as TaskItem's checkbox so "done" reads identically app-wide. */
export function DoneCheck({ done, onToggle }: { done: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={done}
      aria-label={done ? 'Отметить как невыполненную' : 'Отметить как выполненную'}
      onClick={onToggle}
      className={cx(
        'mt-0.5 grid size-4 shrink-0 place-items-center rounded-[4px] border-[1.5px] transition-colors',
        done ? 'border-success bg-success' : 'border-faint hover:border-accent',
      )}
    >
      {done && (
        <svg viewBox="0 0 12 12" className="size-3 text-surface" aria-hidden="true">
          <path d="M2 6.2 4.6 8.8 10 3.4" fill="none" stroke="currentColor" strokeWidth="2" />
        </svg>
      )}
    </button>
  )
}

export function ProjectChip({ project }: { project: Project }) {
  return (
    <span
      className="rounded-[4px] px-1.5 py-px text-[0.69rem] font-medium"
      style={{
        // Mixing toward the text token keeps DB palette colors legible on both
        // the ivory and the charcoal surfaces (mirrors TaskItem).
        color: `color-mix(in srgb, ${project.color} 60%, var(--c-ink))`,
        background: `color-mix(in srgb, ${project.color} 14%, transparent)`,
      }}
    >
      {project.name}
    </span>
  )
}

interface TaskRowProps {
  task: Task
  project: Project | null
  onToggleDone: () => void
  /** Tailwind class for the due date — danger in the overdue group. */
  dueClass?: string
}

/**
 * Right-column row: static title on purpose — the command center is for
 * glancing and checking off, not editing; details live in the list views.
 */
export function TaskRow({ task, project, onToggleDone, dueClass }: TaskRowProps) {
  const done = task.status === 'done'
  return (
    <li className="flex items-start gap-3 px-3 py-2">
      <DoneCheck done={done} onToggle={onToggleDone} />
      <div className="min-w-0 flex-1">
        <div className={cx('truncate text-sm', done && 'text-faint line-through')}>{task.title}</div>
        {!done && (task.due_at || project) && (
          <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1">
            {task.due_at && (
              <span className={cx('font-mono text-[0.68rem]', dueClass ?? 'text-muted')}>
                {formatDueDate(task.due_at)}
              </span>
            )}
            {project && <ProjectChip project={project} />}
          </div>
        )}
      </div>
    </li>
  )
}

interface TimelineRowProps {
  item: TimelineItem
  phase: Phase
  isNext: boolean
  project: Project | null
  onToggleDone: () => void
}

export function TimelineRow({ item, phase, isNext, project, onToggleDone }: TimelineRowProps) {
  const allDay = item.kind === 'event' && item.allDay
  const done = item.kind === 'task' && item.task.status === 'done'
  // All-day rows span the whole day — highlighting them as "current" or fading
  // them as "past" would be noise, so they stay phase-neutral.
  const current = phase === 'current' && !allDay
  const past = phase === 'past' && !allDay

  return (
    <li
      className={cx(
        'flex items-start gap-3 border-b border-sunken px-3 py-2 last:border-b-0',
        past && 'opacity-55',
        // Inset shadow instead of border-l so the accent edge adds no layout shift.
        current && 'shadow-[inset_2px_0_0_0_var(--c-accent)]',
      )}
    >
      <span className="w-[5.75rem] shrink-0 pt-0.5 font-mono text-[0.7rem] text-muted">
        {allDay ? 'весь день' : formatTimeRange(item.start, item.end)}
      </span>

      {item.kind === 'task' && <DoneCheck done={done} onToggle={onToggleDone} />}

      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <span className={cx('min-w-0 flex-1 truncate text-sm', done && 'text-faint line-through')}>
            {item.kind === 'task' ? item.task.title : (item.event.summary ?? 'Без названия')}
          </span>
          {current && (
            <span className="shrink-0 font-mono text-[0.65rem] tracking-[0.08em] text-accent uppercase">
              сейчас
            </span>
          )}
          {isNext && (
            <span className="shrink-0 font-mono text-[0.65rem] tracking-[0.08em] text-accent-2 uppercase">
              далее
            </span>
          )}
        </div>
        <div className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-1">
          {item.kind === 'event' ? (
            <span className="rounded-[4px] bg-accent-2-soft px-1.5 py-px text-[0.69rem] font-medium text-accent-2">
              встреча
            </span>
          ) : (
            project && <ProjectChip project={project} />
          )}
        </div>
      </div>
    </li>
  )
}
