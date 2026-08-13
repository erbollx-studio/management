import { useEffect, useRef, useState, type FormEvent } from 'react'
import { defaultEnd, useScheduleTask, useUnscheduleTask } from '@/data/schedule'
import { useToast } from '@/ui/toast'
import type { Task } from '@/lib/types'

const DURATIONS = [15, 30, 45, 60, 90, 120] as const

const slotDay = new Intl.DateTimeFormat('ru', { day: 'numeric', month: 'short' })
const slotTime = new Intl.DateTimeFormat('ru', { hour: '2-digit', minute: '2-digit' })

/** «13 авг 15:00–16:00» — shared by the dialog and the task-row hint. */
export function formatSlot(startIso: string, endIso: string | null): string {
  const start = new Date(startIso)
  const startPart = `${slotDay.format(start)} ${slotTime.format(start)}`
  return endIso ? `${startPart}–${slotTime.format(new Date(endIso))}` : startPart
}

function nextFullHour(now = new Date()): Date {
  const d = new Date(now)
  d.setMinutes(0, 0, 0)
  d.setHours(d.getHours() + 1)
  return d
}

/** Date -> `<input type="datetime-local">` value in local time. */
function toLocalInput(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** The select offers fixed slots, so an odd estimate snaps to the closest one. */
function initialDuration(estimate: number | null): number {
  if (!estimate) return 60
  return DURATIONS.reduce((best, d) => (Math.abs(d - estimate) < Math.abs(best - estimate) ? d : best), 60)
}

export function ScheduleDialog({ task, onClose }: { task: Task; onClose: () => void }) {
  const schedule = useScheduleTask()
  const unschedule = useUnscheduleTask()
  const { toast } = useToast()
  const inputRef = useRef<HTMLInputElement>(null)
  const [start, setStart] = useState(() => toLocalInput(nextFullHour()))
  const [minutes, setMinutes] = useState(() => initialDuration(task.estimate_minutes))

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  // Escape closes from anywhere, not only while the panel has focus.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  const busy = schedule.isPending || unschedule.isPending

  function handleSubmit(e: FormEvent) {
    e.preventDefault()
    const startDate = new Date(start)
    if (Number.isNaN(startDate.getTime())) return
    const end = defaultEnd(startDate, minutes)
    schedule.mutate(
      { taskId: task.id, start: startDate, end },
      {
        onSuccess: () => {
          toast({ message: `Запланировано на ${formatSlot(startDate.toISOString(), end.toISOString())}` })
          onClose()
        },
      },
    )
  }

  function handleUnschedule() {
    unschedule.mutate(task.id, {
      onSuccess: () => {
        toast({ message: 'Снято с плана' })
        onClose()
      },
    })
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-ink/30 p-4"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Планирование задачи"
        // Clicks inside the panel must not bubble to the backdrop-close handler.
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-sm rounded-card border border-hair bg-surface p-4 shadow-[0_8px_32px_rgb(0_0_0/0.16)]"
      >
        <h2 className="mb-1 font-serif text-base font-semibold">В календарь</h2>
        <p className="mb-3 truncate text-sm text-muted">{task.title}</p>

        {task.scheduled_start && (
          <p className="mb-3 rounded-block bg-sunken px-2 py-1 font-mono text-[0.7rem] text-muted">
            сейчас: {formatSlot(task.scheduled_start, task.scheduled_end)}
          </p>
        )}

        <form onSubmit={handleSubmit} className="flex flex-col gap-3">
          <label className="flex flex-col gap-1">
            <span className="font-mono text-[0.65rem] tracking-[0.1em] text-muted uppercase">Начало</span>
            <input
              ref={inputRef}
              type="datetime-local"
              value={start}
              onChange={(e) => setStart(e.target.value)}
              required
              className="rounded-control border border-rule bg-field px-2 py-1.5 text-sm focus:border-accent focus:ring-[3px] focus:ring-accent/10 focus:outline-none"
            />
          </label>

          <label className="flex flex-col gap-1">
            <span className="font-mono text-[0.65rem] tracking-[0.1em] text-muted uppercase">Длительность</span>
            <select
              value={minutes}
              onChange={(e) => setMinutes(Number(e.target.value))}
              className="rounded-control border border-rule bg-field px-2 py-1.5 text-sm focus:border-accent focus:ring-[3px] focus:ring-accent/10 focus:outline-none"
            >
              {DURATIONS.map((d) => (
                <option key={d} value={d}>
                  {d} мин
                </option>
              ))}
            </select>
          </label>

          <div className="mt-1 flex items-center justify-between gap-2">
            {task.scheduled_start ? (
              <button
                type="button"
                onClick={handleUnschedule}
                disabled={busy}
                className="rounded-control px-2.5 py-1.5 text-sm text-danger transition-colors hover:bg-danger/10 disabled:text-faint"
              >
                Снять с плана
              </button>
            ) : (
              <span />
            )}
            <div className="flex gap-2">
              <button
                type="button"
                onClick={onClose}
                className="rounded-control border border-rule px-3 py-1.5 text-sm transition-colors hover:bg-sunken"
              >
                Отмена
              </button>
              <button
                type="submit"
                disabled={busy}
                className="rounded-control bg-accent px-3 py-1.5 text-sm font-medium text-ground transition-colors hover:bg-ink disabled:bg-hair disabled:text-faint"
              >
                Запланировать
              </button>
            </div>
          </div>
        </form>
      </div>
    </div>
  )
}
