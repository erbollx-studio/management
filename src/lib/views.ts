import type { Task } from './types'
import { endOfDay, isDueOnOrBefore, startOfDay } from './dates'

export type View =
  | { kind: 'today' }
  | { kind: 'upcoming' }
  | { kind: 'inbox' }
  | { kind: 'all' }
  | { kind: 'done' }
  | { kind: 'project'; id: string }
  | { kind: 'calendar' }
  | { kind: 'recurring' }
  | { kind: 'review' }

export function viewKey(view: View): string {
  return view.kind === 'project' ? `project:${view.id}` : view.kind
}

const isActive = (t: Task) => t.status !== 'done' && t.status !== 'cancelled'

export function filterTasks(tasks: Task[], view: View, now = new Date()): Task[] {
  switch (view.kind) {
    case 'today':
      // Overdue belongs here too: a task that slipped yesterday is today's problem.
      return tasks.filter(
        (t) =>
          isActive(t) &&
          (isDueOnOrBefore(t.due_at, now) ||
            (t.scheduled_start !== null &&
              new Date(t.scheduled_start).getTime() <= endOfDay(now).getTime() &&
              new Date(t.scheduled_start).getTime() >= startOfDay(now).getTime())),
      )
    case 'upcoming':
      return tasks.filter((t) => isActive(t) && t.due_at !== null && !isDueOnOrBefore(t.due_at, now))
    case 'inbox':
      return tasks.filter((t) => isActive(t) && t.project_id === null)
    case 'all':
      return tasks.filter(isActive)
    case 'done':
      return tasks.filter((t) => t.status === 'done')
    case 'project':
      return tasks.filter((t) => isActive(t) && t.project_id === view.id)
    case 'calendar':
    case 'recurring':
    case 'review':
      // Not task lists — App renders dedicated panels for these views.
      return []
  }
}

/**
 * Overdue first, then by due date, then by priority, then newest.
 * Undated tasks sink below dated ones rather than interleaving by accident.
 */
export function sortTasks(tasks: Task[]): Task[] {
  return [...tasks].sort((a, b) => {
    if (a.status === 'done' !== (b.status === 'done')) return a.status === 'done' ? 1 : -1
    const ad = a.due_at ? new Date(a.due_at).getTime() : Infinity
    const bd = b.due_at ? new Date(b.due_at).getTime() : Infinity
    if (ad !== bd) return ad - bd
    if (a.priority !== b.priority) return b.priority - a.priority
    return new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
  })
}
