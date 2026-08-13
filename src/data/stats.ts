import { addDays, startOfDay } from '@/lib/dates'
import type { Task } from '@/lib/types'

/**
 * Pure weekly-review derivations for the «Обзор» view. No fetching here:
 * everything is computed from the tasks array the caller already holds,
 * bucketed by local midnights so a task done at 23:59 counts for its own day.
 */

export interface DayStat {
  date: Date
  /** Short Russian weekday («пн», «вт», …). */
  label: string
  done: number
  created: number
}

export interface WeeklyStats {
  /** Last 7 days, oldest first, ending today. */
  days: DayStat[]
  doneThisWeek: number
  createdThisWeek: number
  /** Active tasks whose due_at is already in the past. */
  overdueNow: number
  /** Sum of scheduled block lengths for slots starting within the next 7 days. */
  scheduledMinutesNext7d: number
  /** Share of 'heavy' among active tasks with an energy set; null when none have one. */
  heavyShare: number | null
  /** The day with the most completions; null when the whole week is zero. */
  bestDay: DayStat | null
}

const DAY_MS = 86_400_000

const shortWeekday = new Intl.DateTimeFormat('ru', { weekday: 'short' })

const isActive = (t: Task) => t.status !== 'done' && t.status !== 'cancelled'

export function weeklyStats(tasks: Task[], now = new Date()): WeeklyStats {
  const todayStart = startOfDay(now)
  const weekStart = addDays(todayStart, -6)

  const days: DayStat[] = Array.from({ length: 7 }, (_, i) => {
    const date = addDays(weekStart, i)
    return { date, label: shortWeekday.format(date), done: 0, created: 0 }
  })

  // Rounded (not floored) so DST days — where two local midnights are not
  // exactly 24h apart — still land in the right bucket.
  const bucketIndex = (iso: string): number =>
    Math.round((startOfDay(new Date(iso)).getTime() - weekStart.getTime()) / DAY_MS)

  let overdueNow = 0
  let scheduledMinutesNext7d = 0
  let heavyCount = 0
  let energyCount = 0

  const nowMs = now.getTime()
  const horizonMs = addDays(now, 7).getTime()

  for (const t of tasks) {
    // completed_at attributes the completion day; created_at the creation day.
    if (t.completed_at) {
      const day = days[bucketIndex(t.completed_at)]
      if (day) day.done++
    }
    const createdDay = days[bucketIndex(t.created_at)]
    if (createdDay) createdDay.created++

    if (isActive(t)) {
      if (t.due_at && new Date(t.due_at).getTime() < nowMs) overdueNow++
      if (t.energy) {
        energyCount++
        if (t.energy === 'heavy') heavyCount++
      }
    }

    if (t.scheduled_start && t.scheduled_end) {
      const start = new Date(t.scheduled_start).getTime()
      if (start >= nowMs && start < horizonMs) {
        const minutes = (new Date(t.scheduled_end).getTime() - start) / 60_000
        if (minutes > 0) scheduledMinutesNext7d += minutes
      }
    }
  }

  let doneThisWeek = 0
  let createdThisWeek = 0
  let bestDay: DayStat | null = null
  for (const d of days) {
    doneThisWeek += d.done
    createdThisWeek += d.created
    // Strict > keeps the earliest day on ties, which reads more naturally.
    if (d.done > 0 && (bestDay === null || d.done > bestDay.done)) bestDay = d
  }

  return {
    days,
    doneThisWeek,
    createdThisWeek,
    overdueNow,
    scheduledMinutesNext7d: Math.round(scheduledMinutesNext7d),
    heavyShare: energyCount > 0 ? heavyCount / energyCount : null,
    bestDay,
  }
}
