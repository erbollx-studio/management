import { useState, type FormEvent } from 'react'
import { nextColor, useCreateProject, useProjects } from '@/data/projects'
import { cx } from '@/lib/cx'
import type { Task } from '@/lib/types'
import { filterTasks, viewKey, type View } from '@/lib/views'

const STANDARD_VIEWS: Array<{ view: View; label: string }> = [
  { view: { kind: 'today' }, label: 'Сегодня' },
  { view: { kind: 'upcoming' }, label: 'Предстоящие' },
  { view: { kind: 'inbox' }, label: 'Входящие' },
  { view: { kind: 'all' }, label: 'Все' },
  { view: { kind: 'done' }, label: 'Выполненные' },
]

interface Props {
  current: View
  onSelect: (view: View) => void
  tasks: Task[]
}

export function Sidebar({ current, onSelect, tasks }: Props) {
  const { data: projects = [] } = useProjects()
  const createProject = useCreateProject()
  const [name, setName] = useState('')
  const [adding, setAdding] = useState(false)

  function handleAddProject(e: FormEvent) {
    e.preventDefault()
    const trimmed = name.trim()
    if (!trimmed) return
    createProject.mutate({ name: trimmed, color: nextColor(projects.length), sort_order: projects.length })
    setName('')
    setAdding(false)
  }

  const activeKey = viewKey(current)

  return (
    <nav aria-label="Разделы" className="flex flex-col gap-6">
      <ul className="flex flex-col">
        {STANDARD_VIEWS.map(({ view, label }) => {
          const count = filterTasks(tasks, view).length
          const active = viewKey(view) === activeKey
          return (
            <li key={viewKey(view)}>
              <button
                type="button"
                onClick={() => onSelect(view)}
                aria-current={active ? 'page' : undefined}
                className={cx(
                  'flex w-full items-center justify-between rounded-control px-2.5 py-1.5 text-left text-sm transition-colors',
                  active ? 'bg-sunken font-medium text-ink' : 'text-muted hover:text-ink',
                )}
              >
                <span>{label}</span>
                {count > 0 && <span className="font-mono text-[0.68rem] text-faint tabular-nums">{count}</span>}
              </button>
            </li>
          )
        })}
      </ul>

      <ul className="flex flex-col">
        <li>
          <button
            type="button"
            onClick={() => onSelect({ kind: 'calendar' })}
            aria-current={activeKey === 'calendar' ? 'page' : undefined}
            className={cx(
              'w-full rounded-control px-2.5 py-1.5 text-left text-sm transition-colors',
              activeKey === 'calendar' ? 'bg-sunken font-medium text-ink' : 'text-muted hover:text-ink',
            )}
          >
            Календарь
          </button>
        </li>
      </ul>

      <div className="flex flex-col gap-1">
        <div className="flex items-center justify-between px-2.5">
          <h2 className="font-mono text-[0.65rem] tracking-[0.14em] text-faint uppercase">Проекты</h2>
          <button
            type="button"
            onClick={() => setAdding((v) => !v)}
            aria-label="Добавить проект"
            className="font-mono text-sm leading-none text-faint hover:text-ink"
          >
            +
          </button>
        </div>

        {adding && (
          <form onSubmit={handleAddProject} className="px-2.5 py-1">
            <input
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              onBlur={() => !name.trim() && setAdding(false)}
              placeholder="Название проекта"
              aria-label="Название проекта"
              className="w-full rounded-control border border-rule bg-field px-2 py-1 text-sm placeholder:text-faint focus:border-accent focus:ring-[3px] focus:ring-accent/10 focus:outline-none"
            />
          </form>
        )}

        <ul className="flex flex-col">
          {projects.map((p) => {
            const view: View = { kind: 'project', id: p.id }
            const active = viewKey(view) === activeKey
            const count = filterTasks(tasks, view).length
            return (
              <li key={p.id}>
                <button
                  type="button"
                  onClick={() => onSelect(view)}
                  aria-current={active ? 'page' : undefined}
                  className={cx(
                    'flex w-full items-center gap-2 rounded-control px-2.5 py-1.5 text-left text-sm transition-colors',
                    active ? 'bg-sunken font-medium text-ink' : 'text-muted hover:text-ink',
                  )}
                >
                  <span className="size-2 shrink-0 rounded-full" style={{ background: p.color }} aria-hidden="true" />
                  <span className="min-w-0 flex-1 truncate">{p.name}</span>
                  {count > 0 && <span className="font-mono text-[0.68rem] text-faint tabular-nums">{count}</span>}
                </button>
              </li>
            )
          })}
          {projects.length === 0 && !adding && (
            <li className="px-2.5 py-1.5 text-sm text-faint">Пока нет проектов</li>
          )}
        </ul>
      </div>
    </nav>
  )
}
