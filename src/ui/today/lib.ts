import type { CalendarEvent, Task } from '@/lib/types'
import { endOfDay, startOfDay } from '@/lib/dates'
import { taskIdOfEvent } from '@/data/events'

/**
 * Pure selectors for the Today command center. Everything time-dependent takes
 * `now` explicitly so the view can tick it once a minute and every derived
 * boundary (past/current/next, overdue, done-today) moves together.
 */

export type TimelineItem =
  | { kind: 'task'; id: string; start: Date; end: Date | null; task: Task }
  | { kind: 'event'; id: string; start: Date; end: Date | null; allDay: boolean; event: CalendarEvent }

export type Phase = 'past' | 'current' | 'future'

const hhmm = new Intl.DateTimeFormat('ru', { hour: '2-digit', minute: '2-digit' })
const fullDay = new Intl.DateTimeFormat('ru', { weekday: 'long', day: 'numeric', month: 'long' })

export function formatClock(d: Date): string {
  return hhmm.format(d)
}

export function formatTimeRange(start: Date, end: Date | null): string {
  return end ? `${hhmm.format(start)}–${hhmm.format(end)}` : hhmm.format(start)
}

export function formatDayLabel(d: Date): string {
  return fullDay.format(d)
}

export function isAllDay(item: TimelineItem): boolean {
  return item.kind === 'event' && item.allDay
}

/**
 * Merge today's scheduled tasks with today's calendar events, one row per real
 * thing: an app-owned mirror event that points at a task already present is
 * dropped, because the task row is the interactive one (checkbox, project).
 */
export function buildTimeline(tasks: Task[], events: CalendarEvent[], day: Date): TimelineItem[] {
  const from = startOfDay(day).getTime()
  const to = endOfDay(day).getTime()

  const scheduled = tasks.filter((t) => {
    if (t.status === 'cancelled' || !t.scheduled_start) return false
    const s = new Date(t.scheduled_start).getTime()
    return s >= from && s <= to
  })
  const scheduledIds = new Set(scheduled.map((t) => t.id))
  const scheduledGcalIds = new Set(scheduled.map((t) => t.gcal_event_id).filter(Boolean))

  const items: TimelineItem[] = scheduled.map((t) => ({
    kind: 'task',
    id: `task:${t.id}`,
    // scheduled_start is non-null here — the filter above guarantees it.
    start: new Date(t.scheduled_start as string),
    end: t.scheduled_end ? new Date(t.scheduled_end) : null,
    task: t,
  }))

  for (const e of events) {
    if (e.status === 'cancelled' || !e.start_at) continue
    // Dedupe both ways the link can be expressed: the event's private
    // plannerTaskId, and the task's own gcal_event_id back-reference.
    const linked = taskIdOfEvent(e)
    if (linked && scheduledIds.has(linked)) continue
    if (scheduledGcalIds.has(e.gcal_event_id)) continue
    items.push({
      kind: 'event',
      id: `event:${e.gcal_event_id}`,
      start: new Date(e.start_at),
      end: e.end_at ? new Date(e.end_at) : null,
      allDay: e.is_all_day,
      event: e,
    })
  }

  // All-day events float above the timed flow; the rest read chronologically.
  return items.sort((a, b) => {
    if (isAllDay(a) !== isAllDay(b)) return isAllDay(a) ? -1 : 1
    return a.start.getTime() - b.start.getTime()
  })
}

export function itemPhase(item: TimelineItem, now: Date): Phase {
  const t = now.getTime()
  const start = item.start.getTime()
  // An item without an end is treated as an instant, not an open interval.
  const end = item.end ? item.end.getTime() : start
  if (end < t) return 'past'
  if (start <= t) return 'current'
  return 'future'
}

/**
 * Where the "now" rule renders: before the first timed future row, after
 * everything when the whole day is behind us, nowhere when nothing is timed.
 */
export function nowLineIndex(items: TimelineItem[], now: Date): number | null {
  let hasTimed = false
  for (const [i, item] of items.entries()) {
    if (isAllDay(item)) continue
    hasTimed = true
    if (itemPhase(item, now) === 'future') return i
  }
  return hasTimed ? items.length : null
}

/** Index of the first upcoming timed row — it gets the «далее» label. */
export function nextItemIndex(items: TimelineItem[], now: Date): number | null {
  for (const [i, item] of items.entries()) {
    if (isAllDay(item)) continue
    if (itemPhase(item, now) === 'future') return i
  }
  return null
}

export interface DayGroups {
  overdue: Task[]
  dueToday: Task[]
  /** No due date, priority >= 2, not scheduled — surfaced so they don't rot. */
  important: Task[]
  doneToday: Task[]
}

export function selectDayGroups(tasks: Task[], now: Date): DayGroups {
  const from = startOfDay(now).getTime()
  const eod = endOfDay(now).getTime()
  const nowMs = now.getTime()
  const at = (iso: string | null) => (iso ? new Date(iso).getTime() : 0)

  const overdue: Task[] = []
  const dueToday: Task[] = []
  const important: Task[] = []
  const doneToday: Task[] = []

  for (const t of tasks) {
    if (t.status === 'done') {
      const c = at(t.completed_at)
      if (c >= from && c <= eod) doneToday.push(t)
      continue
    }
    if (t.status === 'cancelled') continue
    if (t.due_at) {
      const d = at(t.due_at)
      if (d < nowMs) overdue.push(t)
      else if (d <= eod) dueToday.push(t)
    } else if (t.priority >= 2 && !t.scheduled_start) {
      important.push(t)
    }
  }

  overdue.sort((a, b) => at(a.due_at) - at(b.due_at))
  dueToday.sort((a, b) => at(a.due_at) - at(b.due_at) || b.priority - a.priority)
  important.sort((a, b) => b.priority - a.priority || at(b.created_at) - at(a.created_at))
  doneToday.sort((a, b) => at(b.completed_at) - at(a.completed_at))

  return { overdue, dueToday, important, doneToday }
}

/**
 * «N из M»: numerator is what got done today; denominator is everything the
 * day is answerable for — overdue debt, today's dues, flagged important work,
 * and what is already finished, so the bar fills rather than shrinks.
 */
export function dayProgress(g: DayGroups): { done: number; total: number } {
  const done = g.doneToday.length
  return { done, total: g.overdue.length + g.dueToday.length + g.important.length + done }
}
