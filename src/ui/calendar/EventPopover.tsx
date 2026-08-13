import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useProjects } from '@/data/projects'
import { useScheduleTask, useUnscheduleTask } from '@/data/schedule'
import { toggleDonePatch, useUpdateTask } from '@/data/tasks'
import { useToast } from '@/ui/toast'
import type { Task } from '@/lib/types'

const timeFmt = new Intl.DateTimeFormat('ru', { hour: '2-digit', minute: '2-digit' })
const dayFmt = new Intl.DateTimeFormat('ru', { weekday: 'short', day: 'numeric', month: 'short' })

/**
 * Small anchored card for app-owned events: the actions a scheduled task needs
 * without leaving the grid. Foreign events never reach here — they open their
 * Google link instead.
 */
export function EventPopover({ task, start, end, x, y, onClose }: {
  task: Task
  start: Date
  end: Date
  /** Click coordinates (viewport) the card anchors to. */
  x: number
  y: number
  onClose: () => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState({ left: x, top: y })
  const { data: projects = [] } = useProjects()
  const updateTask = useUpdateTask()
  const unscheduleTask = useUnscheduleTask()
  const scheduleTask = useScheduleTask()
  const { toast } = useToast()

  const project = task.project_id ? projects.find((p) => p.id === task.project_id) : undefined

  // Clamp to the viewport after the first paint, once the real size is known.
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const r = el.getBoundingClientRect()
    setPos({
      left: Math.max(8, Math.min(x, window.innerWidth - r.width - 8)),
      top: Math.max(8, Math.min(y, window.innerHeight - r.height - 8)),
    })
  }, [x, y])

  useEffect(() => {
    // Focus the card so Escape works immediately; hand focus back on close.
    const opener = document.activeElement as HTMLElement | null
    ref.current?.focus()

    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        e.stopPropagation()
        onClose()
      }
    }
    function onPointerDown(e: PointerEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose()
    }
    document.addEventListener('keydown', onKeyDown, true)
    // Capture phase so clicks swallowed by FullCalendar still close the card.
    document.addEventListener('pointerdown', onPointerDown, true)
    return () => {
      document.removeEventListener('keydown', onKeyDown, true)
      document.removeEventListener('pointerdown', onPointerDown, true)
      opener?.focus()
    }
  }, [onClose])

  function markDone() {
    // Snapshot the exact columns the patch touches so undo is a clean restore.
    const snapshot = { status: task.status, completed_at: task.completed_at }
    updateTask.mutate({ id: task.id, patch: toggleDonePatch(task) })
    toast({
      message: `Сделано: ${task.title}`,
      actionLabel: 'Отменить',
      onAction: () => updateTask.mutate({ id: task.id, patch: snapshot }),
    })
    onClose()
  }

  function unschedule() {
    unscheduleTask.mutate(task.id)
    toast({
      message: `Снято с плана: ${task.title}`,
      actionLabel: 'Отменить',
      // Re-scheduling with the original slot is the exact inverse write.
      onAction: () => scheduleTask.mutate({ taskId: task.id, start, end }),
    })
    onClose()
  }

  return (
    <div
      ref={ref}
      role="dialog"
      aria-modal="true"
      aria-label={task.title}
      tabIndex={-1}
      style={{ left: pos.left, top: pos.top }}
      className="fixed z-50 w-72 max-w-[calc(100vw-1rem)] rounded-card border border-hair bg-surface shadow-[0_4px_16px_rgb(0_0_0/0.08)] focus:outline-none"
    >
      <div className="border-b border-hair px-3.5 py-2.5">
        <p className="text-sm font-medium">{task.title}</p>
        <p className="mt-1 font-mono text-[0.68rem] text-muted">
          {dayFmt.format(start)} · {timeFmt.format(start)}–{timeFmt.format(end)}
        </p>
        {project && (
          <span className="mt-1.5 inline-flex max-w-full items-center gap-1.5 rounded-control border border-hair px-1.5 py-0.5 text-[0.7rem] text-muted">
            <span
              className="size-2 shrink-0 rounded-full"
              style={{ background: project.color }}
              aria-hidden="true"
            />
            <span className="min-w-0 truncate">{project.name}</span>
          </span>
        )}
      </div>
      <div className="flex items-center gap-1.5 px-2 py-2">
        <button
          type="button"
          onClick={markDone}
          className="rounded-control px-2 py-1 text-[0.8rem] font-medium text-success transition-colors hover:bg-sunken"
        >
          Сделано
        </button>
        <button
          type="button"
          onClick={unschedule}
          className="rounded-control px-2 py-1 text-[0.8rem] text-muted transition-colors hover:bg-sunken hover:text-ink"
        >
          Снять с плана
        </button>
        <button
          type="button"
          onClick={onClose}
          className="ml-auto rounded-control px-2 py-1 font-mono text-xs text-faint transition-colors hover:text-ink"
        >
          Закрыть
        </button>
      </div>
    </div>
  )
}
