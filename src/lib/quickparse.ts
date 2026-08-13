import type { Priority, Project } from '@/lib/types'
import { addDays, endOfDay, formatDueDate, formatEstimate, startOfDay } from '@/lib/dates'

/**
 * Natural-language quick-add parser (Russian). Pure: the only clock read is
 * `new Date()` at call time, so the same input at the same instant always
 * yields the same result. Tokens may appear in any order; whatever is not
 * recognised stays in the title.
 */

export type QuickChipKind = 'due' | 'time' | 'priority' | 'estimate' | 'project'

export type QuickChip = { kind: QuickChipKind; label: string }

/** Subset of TaskInsert the parser can fill in. */
export type QuickPatch = {
  due_at?: string
  priority?: Priority
  estimate_minutes?: number
  project_id?: string
}

export type QuickParseResult = {
  title: string
  patch: QuickPatch
  chips: QuickChip[]
}

const RELATIVE: Record<string, number> = { сегодня: 0, завтра: 1, послезавтра: 2 }

/** JS getDay() numbering: Sunday is 0. */
const WEEKDAYS: Record<string, number> = { пн: 1, вт: 2, ср: 3, чт: 4, пт: 5, сб: 6, вс: 0 }

const PRIORITY_WORDS: Record<string, Exclude<Priority, 0>> = { высокий: 3, средний: 2, низкий: 1 }

const PRIORITY_LABEL: Record<Exclude<Priority, 0>, string> = { 1: 'Низкий', 2: 'Средний', 3: 'Высокий' }

const pad2 = (n: number) => String(n).padStart(2, '0')

function parseClock(s: string, requireColon: boolean): { h: number; m: number } | null {
  const m = /^(\d{1,2})(?::(\d{2}))?$/.exec(s)
  if (!m) return null
  // Without the «в» preposition a bare number is more likely part of the
  // title, so standalone times must carry the colon («15:00»).
  if (requireColon && !m[2]) return null
  const h = Number(m[1])
  const min = m[2] ? Number(m[2]) : 0
  if (h > 23 || min > 59) return null
  return { h, m: min }
}

function parseDateWord(w: string, now: Date): Date | null {
  if (Object.hasOwn(RELATIVE, w)) return addDays(now, RELATIVE[w] ?? 0)
  if (Object.hasOwn(WEEKDAYS, w)) {
    const target = WEEKDAYS[w] ?? 0
    // "Next occurrence": naming today's weekday means the following week,
    // otherwise «сегодня» already covers it.
    const ahead = (target - now.getDay() + 7) % 7 || 7
    return addDays(now, ahead)
  }
  const m = /^(\d{1,2})\.(\d{1,2})(?:\.(\d{4}))?$/.exec(w)
  if (m) {
    const day = Number(m[1])
    const month = Number(m[2])
    if (month < 1 || month > 12 || day < 1) return null
    const year = m[3] ? Number(m[3]) : now.getFullYear()
    const d = new Date(year, month - 1, day)
    // Date() silently rolls impossible days over («31.02» → 3 Mar); treat
    // those as not-a-date so they stay in the title.
    if (d.getMonth() !== month - 1 || d.getDate() !== day) return null
    // A yearless date already behind us means the next such date, not last
    // year's — nobody quick-adds tasks into the past.
    if (!m[3] && startOfDay(d).getTime() < startOfDay(now).getTime()) d.setFullYear(year + 1)
    return d
  }
  return null
}

function parsePriority(body: string): Exclude<Priority, 0> | null {
  if (Object.hasOwn(PRIORITY_WORDS, body)) return PRIORITY_WORDS[body] ?? null
  // Numeric shorthand maps directly: !1 low … !3 high.
  if (/^[123]$/.test(body)) return Number(body) as Exclude<Priority, 0>
  return null
}

function parseEstimate(w: string): number | null {
  let m = /^(\d+)м$/.exec(w)
  if (m) {
    const n = Number(m[1])
    return n > 0 ? n : null
  }
  // «1ч», «1.5ч», «1,5ч», «1ч30»
  m = /^(\d+(?:[.,]\d+)?)ч(\d{1,2})?$/.exec(w)
  if (m) {
    const hours = Number((m[1] ?? '0').replace(',', '.'))
    const extra = m[2] ? Number(m[2]) : 0
    const total = Math.round(hours * 60 + extra)
    return total > 0 ? total : null
  }
  return null
}

export function parseQuickAdd(input: string, projects: Project[]): QuickParseResult {
  const now = new Date()
  const words = input.trim().split(/\s+/).filter(Boolean)
  const rest: string[] = []

  // First match of each kind wins; repeats fall through into the title so the
  // user can see something went unconsumed instead of being silently dropped.
  let date: Date | null = null
  let time: { h: number; m: number } | null = null
  let priority: Exclude<Priority, 0> | null = null
  let estimate: number | null = null
  let project: Project | null = null

  for (let i = 0; i < words.length; i++) {
    const raw = words[i] ?? ''
    const w = raw.toLowerCase()

    // «в 15» / «в 15:30» — the preposition promotes a bare number to a time.
    if (time === null && w === 'в' && i + 1 < words.length) {
      const clock = parseClock(words[i + 1] ?? '', false)
      if (clock) {
        time = clock
        i++
        continue
      }
    }
    // «в пт» — swallow the preposition too, or it dangles in the title.
    if (date === null && w === 'в' && i + 1 < words.length) {
      const next = (words[i + 1] ?? '').toLowerCase()
      if (Object.hasOwn(WEEKDAYS, next)) {
        date = parseDateWord(next, now)
        i++
        continue
      }
    }
    if (time === null) {
      const clock = parseClock(w, true)
      if (clock) {
        time = clock
        continue
      }
    }
    if (date === null) {
      const d = parseDateWord(w, now)
      if (d) {
        date = d
        continue
      }
    }
    if (priority === null && w.startsWith('!')) {
      const p = parsePriority(w.slice(1))
      if (p !== null) {
        priority = p
        continue
      }
    }
    if (estimate === null) {
      const e = parseEstimate(w)
      if (e !== null) {
        estimate = e
        continue
      }
    }
    if (project === null && raw.startsWith('#') && raw.length > 1) {
      const name = raw.slice(1).toLowerCase()
      const found = projects.find((p) => p.name.toLowerCase() === name)
      if (found) {
        project = found
        continue
      }
      // No such project: keep «#слово» in the title untouched.
    }
    rest.push(raw)
  }

  const chips: QuickChip[] = []
  const patch: QuickPatch = {}

  if (date !== null || time !== null) {
    const base = date ?? now
    // An explicit time makes the deadline exact; a bare date keeps the app's
    // "by the end of that day" convention (same anchor as dateInputToDueAt).
    const due = time
      ? new Date(base.getFullYear(), base.getMonth(), base.getDate(), time.h, time.m, 0, 0)
      : endOfDay(base)
    patch.due_at = due.toISOString()
    chips.push({ kind: 'due', label: formatDueDate(patch.due_at, now) })
    if (time) chips.push({ kind: 'time', label: `${pad2(time.h)}:${pad2(time.m)}` })
  }
  if (priority !== null) {
    patch.priority = priority
    chips.push({ kind: 'priority', label: PRIORITY_LABEL[priority] })
  }
  if (estimate !== null) {
    patch.estimate_minutes = estimate
    chips.push({ kind: 'estimate', label: formatEstimate(estimate) })
  }
  if (project !== null) {
    patch.project_id = project.id
    chips.push({ kind: 'project', label: project.name })
  }

  return { title: rest.join(' '), patch, chips }
}
