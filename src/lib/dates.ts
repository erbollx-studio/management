/**
 * Everything is stored as timestamptz (UTC) and rendered in the browser's
 * timezone. A due date means "by the end of that day", so a date picked in the
 * UI is anchored to 23:59:59 local before it becomes an instant.
 */

export function startOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0, 0)
}

export function endOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59, 59, 999)
}

export function addDays(d: Date, n: number): Date {
  const out = new Date(d)
  out.setDate(out.getDate() + n)
  return out
}

/** `<input type="date">` value -> ISO instant at end of that local day. */
export function dateInputToDueAt(value: string): string | null {
  if (!value) return null
  const [y, m, d] = value.split('-').map(Number)
  if (!y || !m || !d) return null
  return endOfDay(new Date(y, m - 1, d)).toISOString()
}

/** ISO instant -> `<input type="date">` value in local time. */
export function dueAtToDateInput(iso: string | null): string {
  if (!iso) return ''
  const d = new Date(iso)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

export function isOverdue(iso: string | null): boolean {
  return iso !== null && new Date(iso).getTime() < Date.now()
}

export function isDueOnOrBefore(iso: string | null, day: Date): boolean {
  return iso !== null && new Date(iso).getTime() <= endOfDay(day).getTime()
}

const relative = new Intl.RelativeTimeFormat('ru', { numeric: 'auto' })
const dayMonth = new Intl.DateTimeFormat('ru', { day: 'numeric', month: 'short' })
const dayMonthYear = new Intl.DateTimeFormat('ru', { day: 'numeric', month: 'short', year: 'numeric' })

/** "сегодня", "завтра", "12 авг" — whichever reads fastest at a glance. */
export function formatDueDate(iso: string | null, now = new Date()): string {
  if (!iso) return ''
  const due = new Date(iso)
  const days = Math.round((startOfDay(due).getTime() - startOfDay(now).getTime()) / 86_400_000)
  if (Math.abs(days) <= 1) return relative.format(days, 'day')
  if (due.getFullYear() === now.getFullYear()) return dayMonth.format(due)
  return dayMonthYear.format(due)
}

export function formatEstimate(minutes: number | null): string {
  if (!minutes) return ''
  if (minutes < 60) return `${minutes}м`
  const h = Math.floor(minutes / 60)
  const m = minutes % 60
  return m ? `${h}ч ${m}м` : `${h}ч`
}
