import { useState } from 'react'
import { cx } from '@/lib/cx'
import { dateInputToDueAt, dueAtToDateInput, formatDueDate, formatEstimate, isOverdue } from '@/lib/dates'
import { ScheduleDialog, formatSlot } from '@/ui/ScheduleDialog'
import type { Priority, Project, Task, TaskPatch } from '@/lib/types'

const PRIORITY_LABEL: Record<Priority, string> = {
  0: 'Без приоритета',
  1: 'Низкий',
  2: 'Средний',
  3: 'Высокий',
}

const PRIORITY_COLOR: Record<Priority, string | null> = {
  0: null,
  1: 'var(--c-prio-1)',
  2: 'var(--c-prio-2)',
  3: 'var(--c-prio-3)',
}

interface Props {
  task: Task
  projects: Project[]
  onPatch: (patch: TaskPatch) => void
  onToggleDone: () => void
  onDelete: () => void
}

export function TaskItem({ task, projects, onPatch, onToggleDone, onDelete }: Props) {
  const [open, setOpen] = useState(false)
  const [planOpen, setPlanOpen] = useState(false)
  const [title, setTitle] = useState(task.title)

  const done = task.status === 'done'
  const project = projects.find((p) => p.id === task.project_id) ?? null
  const overdue = !done && isOverdue(task.due_at)

  function commitTitle() {
    const trimmed = title.trim()
    if (!trimmed) {
      setTitle(task.title)
      return
    }
    if (trimmed !== task.title) onPatch({ title: trimmed })
  }

  return (
    <li className="border-b border-sunken last:border-b-0">
      <div className="flex items-start gap-3 px-3 py-2">
        <button
          type="button"
          role="checkbox"
          aria-checked={done}
          aria-label={done ? 'Отметить как невыполненную' : 'Отметить как выполненную'}
          onClick={onToggleDone}
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

        <div className="min-w-0 flex-1">
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            onBlur={commitTitle}
            onKeyDown={(e) => {
              if (e.key === 'Enter') e.currentTarget.blur()
              if (e.key === 'Escape') {
                setTitle(task.title)
                e.currentTarget.blur()
              }
            }}
            aria-label="Название задачи"
            className={cx(
              'w-full bg-transparent text-sm focus:outline-none',
              done && 'text-faint line-through',
            )}
          />

          <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-[0.68rem] text-muted">
            {PRIORITY_COLOR[task.priority] && (
              <span className="flex items-center gap-1">
                <span
                  className="size-1.5 rounded-full"
                  style={{ background: PRIORITY_COLOR[task.priority] ?? undefined }}
                  aria-hidden="true"
                />
                {PRIORITY_LABEL[task.priority]}
              </span>
            )}
            {task.due_at && (
              <span className={cx(overdue && 'text-danger')}>{formatDueDate(task.due_at)}</span>
            )}
            {task.estimate_minutes && <span>{formatEstimate(task.estimate_minutes)}</span>}
            {project && (
              <span
                className="rounded-[4px] px-1.5 py-px font-sans text-[0.69rem] font-medium"
                style={{
                  // Mixing toward the text token keeps DB palette colors legible
                  // on both the ivory and the charcoal surfaces.
                  color: `color-mix(in srgb, ${project.color} 60%, var(--c-ink))`,
                  background: `color-mix(in srgb, ${project.color} 14%, transparent)`,
                }}
              >
                {project.name}
              </span>
            )}
          </div>
        </div>

        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          aria-label={open ? 'Свернуть детали' : 'Показать детали'}
          className="shrink-0 px-1 font-mono text-xs text-faint hover:text-ink"
        >
          {open ? '−' : '+'}
        </button>
      </div>

      {open && (
        <div className="grid gap-3 border-t border-hair bg-sunken px-3 py-3 sm:grid-cols-2">
          <label className="sm:col-span-2 flex flex-col gap-1">
            <span className="font-mono text-[0.65rem] tracking-[0.1em] text-muted uppercase">Заметки</span>
            <textarea
              defaultValue={task.notes ?? ''}
              onBlur={(e) => {
                const v = e.target.value.trim()
                if (v !== (task.notes ?? '')) onPatch({ notes: v || null })
              }}
              rows={2}
              className="resize-y rounded-control border border-rule bg-field px-2 py-1.5 text-sm focus:border-accent focus:ring-[3px] focus:ring-accent/10 focus:outline-none"
            />
          </label>

          <label className="flex flex-col gap-1">
            <span className="font-mono text-[0.65rem] tracking-[0.1em] text-muted uppercase">Срок</span>
            <input
              type="date"
              defaultValue={dueAtToDateInput(task.due_at)}
              onChange={(e) => onPatch({ due_at: dateInputToDueAt(e.target.value) })}
              className="rounded-control border border-rule bg-field px-2 py-1.5 text-sm focus:border-accent focus:ring-[3px] focus:ring-accent/10 focus:outline-none"
            />
          </label>

          <label className="flex flex-col gap-1">
            <span className="font-mono text-[0.65rem] tracking-[0.1em] text-muted uppercase">Оценка, мин</span>
            <input
              type="number"
              min={1}
              max={1440}
              step={5}
              defaultValue={task.estimate_minutes ?? ''}
              onBlur={(e) => {
                const n = e.target.value ? Number(e.target.value) : null
                if (n !== task.estimate_minutes) onPatch({ estimate_minutes: n })
              }}
              className="rounded-control border border-rule bg-field px-2 py-1.5 text-sm focus:border-accent focus:ring-[3px] focus:ring-accent/10 focus:outline-none"
            />
          </label>

          <label className="flex flex-col gap-1">
            <span className="font-mono text-[0.65rem] tracking-[0.1em] text-muted uppercase">Проект</span>
            <select
              value={task.project_id ?? ''}
              onChange={(e) => onPatch({ project_id: e.target.value || null })}
              className="rounded-control border border-rule bg-field px-2 py-1.5 text-sm focus:border-accent focus:ring-[3px] focus:ring-accent/10 focus:outline-none"
            >
              <option value="">Входящие</option>
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>

          <label className="flex flex-col gap-1">
            <span className="font-mono text-[0.65rem] tracking-[0.1em] text-muted uppercase">Приоритет</span>
            <select
              value={task.priority}
              onChange={(e) => onPatch({ priority: Number(e.target.value) as Priority })}
              className="rounded-control border border-rule bg-field px-2 py-1.5 text-sm focus:border-accent focus:ring-[3px] focus:ring-accent/10 focus:outline-none"
            >
              {([0, 1, 2, 3] as const).map((p) => (
                <option key={p} value={p}>
                  {PRIORITY_LABEL[p]}
                </option>
              ))}
            </select>
          </label>

          <div className="sm:col-span-2 flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => setPlanOpen(true)}
              className="rounded-control border border-rule px-2.5 py-1 font-mono text-[0.7rem] transition-colors hover:border-accent"
            >
              {task.scheduled_start ? 'Перенести' : 'В календарь'}
            </button>
            {task.scheduled_start && (
              <span className="font-mono text-[0.68rem] text-muted">
                {formatSlot(task.scheduled_start, task.scheduled_end)}
              </span>
            )}
          </div>

          <div className="sm:col-span-2 flex items-center justify-between border-t border-hair pt-3">
            <span className="font-mono text-[0.65rem] text-faint">
              создана {new Date(task.created_at).toLocaleDateString('ru')}
            </span>
            <button
              type="button"
              onClick={onDelete}
              className="rounded-control border border-rule px-2.5 py-1 font-mono text-[0.7rem] text-danger transition-colors hover:border-danger"
            >
              Удалить
            </button>
          </div>
        </div>
      )}

      {planOpen && <ScheduleDialog task={task} onClose={() => setPlanOpen(false)} />}
    </li>
  )
}
