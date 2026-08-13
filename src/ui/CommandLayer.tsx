import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { cx } from '@/lib/cx'
import { formatDueDate } from '@/lib/dates'
import type { Project, Task } from '@/lib/types'

/**
 * Self-contained keyboard layer: global hotkeys + a search overlay. Owns no
 * data — the coordinator mounts it once with the live task/project lists and
 * a navigation callback.
 */

export type NavView =
  | { kind: 'today' | 'upcoming' | 'inbox' | 'all' | 'done' | 'calendar' }
  | { kind: 'project'; id: string }

interface Props {
  tasks: Task[]
  projects: Project[]
  onNavigate: (view: NavView) => void
}

const DIGIT_VIEWS: Record<string, NavView> = {
  '1': { kind: 'today' },
  '2': { kind: 'upcoming' },
  '3': { kind: 'inbox' },
  '4': { kind: 'all' },
  '5': { kind: 'calendar' },
}

const MAX_RESULTS = 12

function isTypingTarget(el: EventTarget | null): boolean {
  if (!(el instanceof HTMLElement)) return false
  return (
    el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable
  )
}

/** Title with the matched substring in bold; notes-only matches render plain. */
function Highlight({ text, query }: { text: string; query: string }) {
  const i = text.toLowerCase().indexOf(query)
  if (i < 0 || !query) return <>{text}</>
  return (
    <>
      {text.slice(0, i)}
      <b className="font-semibold">{text.slice(i, i + query.length)}</b>
      {text.slice(i + query.length)}
    </>
  )
}

export function CommandLayer({ tasks, projects, onNavigate }: Props) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)

  const close = useCallback(() => {
    setOpen(false)
    setQuery('')
    setActive(0)
  }, [])

  // Global hotkeys. One listener for the component's whole life; removed on
  // unmount so nothing leaks when the coordinator swaps layouts.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      // Plain keys only — leave browser/OS shortcuts alone.
      if (e.ctrlKey || e.metaKey || e.altKey) return
      if (isTypingTarget(e.target)) return
      // Any open dialog (schedule modal, the search overlay itself) owns the
      // keyboard — the aria-modal marker is the shared contract for that.
      if (document.querySelector('[aria-modal="true"]')) return

      if (e.key === '/') {
        e.preventDefault()
        setOpen(true)
        return
      }
      if (e.key === 'n') {
        // The quick-add input is looked up by its accessible name so this
        // layer stays decoupled from where QuickAdd happens to be mounted.
        const quickAdd = document.querySelector<HTMLInputElement>(
          'input[aria-label="Название новой задачи"]',
        )
        if (quickAdd) {
          e.preventDefault()
          quickAdd.focus()
        }
        return
      }
      const view = DIGIT_VIEWS[e.key]
      if (view) {
        e.preventDefault()
        onNavigate(view)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onNavigate])

  // Escape must close the overlay even when focus has wandered off the input
  // (e.g. onto a result row via Tab). Attached only while open, removed on
  // close/unmount so nothing leaks.
  useEffect(() => {
    if (!open) return
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') close()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open, close])

  const q = query.trim().toLowerCase()

  const results = useMemo(() => {
    if (!q) return []
    const matches = tasks.filter(
      (t) => t.title.toLowerCase().includes(q) || (t.notes ?? '').toLowerCase().includes(q),
    )
    // Active work first — done tasks are usually noise when searching.
    return [...matches.filter((t) => t.status !== 'done'), ...matches.filter((t) => t.status === 'done')].slice(
      0,
      MAX_RESULTS,
    )
  }, [tasks, q])

  // Keep the cursor on a real row when the result set shrinks under it.
  useEffect(() => {
    setActive((i) => Math.min(i, Math.max(0, results.length - 1)))
  }, [results.length])

  const select = useCallback(
    (task: Task) => {
      // The task's "natural" home: its project list when it has one; done
      // tasks live only in the done view; the rest sit in the inbox.
      if (task.project_id && task.status !== 'done') onNavigate({ kind: 'project', id: task.project_id })
      else if (task.status === 'done') onNavigate({ kind: 'done' })
      else onNavigate({ kind: 'inbox' })
      close()
    },
    [onNavigate, close],
  )

  if (!open) return null

  return (
    <div className="fixed inset-0 z-50 bg-ink/30 p-4" onClick={close}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Поиск задач"
        onClick={(e) => e.stopPropagation()}
        className="mx-auto mt-[12vh] w-full max-w-lg overflow-hidden rounded-card border border-hair bg-surface shadow-[0_8px_32px_rgb(0_0_0/0.16)]"
      >
        <input
          ref={inputRef}
          // Autofocus is safe here: the input mounts together with the overlay.
          autoFocus
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              e.preventDefault()
              close()
            } else if (e.key === 'ArrowDown') {
              e.preventDefault()
              setActive((i) => Math.min(i + 1, results.length - 1))
            } else if (e.key === 'ArrowUp') {
              e.preventDefault()
              setActive((i) => Math.max(i - 1, 0))
            } else if (e.key === 'Enter') {
              e.preventDefault()
              const hit = results[active]
              if (hit) select(hit)
            }
          }}
          placeholder="Поиск задач…"
          aria-label="Поиск задач"
          className="w-full border-b border-hair bg-field px-4 py-3 text-sm placeholder:text-faint focus:outline-none"
        />

        {q && (
          <ul className="max-h-[50vh] overflow-y-auto">
            {results.length === 0 && (
              <li className="px-4 py-6 text-center text-sm text-faint">Ничего не найдено</li>
            )}
            {results.map((task, i) => {
              const project = projects.find((p) => p.id === task.project_id) ?? null
              const done = task.status === 'done'
              return (
                <li key={task.id}>
                  <button
                    type="button"
                    onClick={() => select(task)}
                    onMouseEnter={() => setActive(i)}
                    className={cx(
                      'flex w-full items-center gap-3 px-4 py-2 text-left text-sm',
                      i === active && 'bg-sunken',
                    )}
                  >
                    <span className={cx('min-w-0 flex-1 truncate', done && 'text-faint line-through')}>
                      <Highlight text={task.title} query={q} />
                    </span>
                    {project && (
                      <span
                        className="shrink-0 rounded-[4px] px-1.5 py-px text-[0.69rem] font-medium"
                        style={{
                          color: `color-mix(in srgb, ${project.color} 60%, var(--c-ink))`,
                          background: `color-mix(in srgb, ${project.color} 14%, transparent)`,
                        }}
                      >
                        {project.name}
                      </span>
                    )}
                    {task.due_at && (
                      <span className="shrink-0 font-mono text-[0.68rem] text-muted">
                        {formatDueDate(task.due_at)}
                      </span>
                    )}
                  </button>
                </li>
              )
            })}
          </ul>
        )}
      </div>
    </div>
  )
}
