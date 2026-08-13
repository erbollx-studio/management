import type { Priority, TaskTemplate } from '@/lib/types'

/** ISO weekday order: index 0 is Monday (ISO 1) … index 6 is Sunday (ISO 7). */
export const DAY_LABELS = ['пн', 'вт', 'ср', 'чт', 'пт', 'сб', 'вс'] as const

export const PRIORITY_LABEL: Record<Priority, string> = {
  0: 'Без приоритета',
  1: 'Низкий',
  2: 'Средний',
  3: 'Высокий',
}

export const PRIORITY_COLOR: Record<Priority, string | null> = {
  0: null,
  1: 'var(--c-prio-1)',
  2: 'var(--c-prio-2)',
  3: 'var(--c-prio-3)',
}

/** «каждый день», «по будням», «пн, ср, пт» — whichever reads fastest. */
export function formatRepeatRule(t: Pick<TaskTemplate, 'repeat_rule' | 'custom_days'>): string {
  if (t.repeat_rule === 'daily') return 'каждый день'
  if (t.repeat_rule === 'weekdays') return 'по будням'
  const days = [...(t.custom_days ?? [])].sort((a, b) => a - b)
  if (days.length === 0) return 'дни не выбраны'
  if (days.length === 7) return 'каждый день'
  return days.map((d) => DAY_LABELS[d - 1] ?? '?').join(', ')
}

/** The DB time column returns 'HH:MM:SS'; inputs and cards want 'HH:MM'. */
export function toHHMM(time: string | null): string {
  return time ? time.slice(0, 5) : ''
}
