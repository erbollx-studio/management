import { useMemo, useState, type FormEvent } from 'react'
import { useCreateTask } from '@/data/tasks'
import { useProjects } from '@/data/projects'
import { parseQuickAdd } from '@/lib/quickparse'
import type { View } from '@/lib/views'

/** Priority chip tint follows the same token scale the task rows use. */
const PRIORITY_VAR: Record<number, string> = {
  1: 'var(--c-prio-1)',
  2: 'var(--c-prio-2)',
  3: 'var(--c-prio-3)',
}

export function QuickAdd({ view }: { view: View }) {
  const [title, setTitle] = useState('')
  const create = useCreateTask()
  const { data: projects = [] } = useProjects()

  // Re-parsed on every keystroke so the chips preview exactly what submit
  // will write — the parse is a cheap single pass over a short string.
  const parsed = useMemo(() => parseQuickAdd(title, projects), [title, projects])
  const tokenProject = projects.find((p) => p.id === parsed.patch.project_id) ?? null

  function handleSubmit(e: FormEvent) {
    e.preventDefault()
    if (!parsed.title) return
    create.mutate({
      title: parsed.title,
      ...parsed.patch,
      // A task added inside a project view belongs to that project — unless
      // a #проект token explicitly points elsewhere.
      project_id: parsed.patch.project_id ?? (view.kind === 'project' ? view.id : null),
    })
    setTitle('')
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-1.5">
      <div className="flex gap-2">
        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="Новая задача… (завтра 15:00 !высокий #Работа 30м)"
          aria-label="Название новой задачи"
          className="min-w-0 flex-1 rounded-control border border-rule bg-field px-3 py-2 text-sm placeholder:text-faint focus:border-accent focus:ring-[3px] focus:ring-accent/10 focus:outline-none"
        />
        <button
          type="submit"
          disabled={!parsed.title || create.isPending}
          className="shrink-0 rounded-control bg-accent px-4 py-2 text-sm font-medium text-ground transition-colors hover:bg-ink disabled:bg-hair disabled:text-faint"
        >
          Добавить
        </button>
      </div>

      {parsed.chips.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5" aria-live="polite">
          {parsed.chips.map((chip) => {
            const base = 'rounded-block px-1.5 py-0.5 text-[0.68rem] font-medium'
            if (chip.kind === 'due' || chip.kind === 'time')
              return (
                <span key={chip.kind} className={`${base} bg-warn/12 text-warn`}>
                  {chip.label}
                </span>
              )
            if (chip.kind === 'priority')
              return (
                <span
                  key={chip.kind}
                  className={base}
                  style={{
                    // Mixed toward ink/transparent like the task-row project
                    // chips so palette colors stay legible on both themes.
                    color: `color-mix(in srgb, ${PRIORITY_VAR[parsed.patch.priority ?? 1]} 75%, var(--c-ink))`,
                    background: `color-mix(in srgb, ${PRIORITY_VAR[parsed.patch.priority ?? 1]} 14%, transparent)`,
                  }}
                >
                  {chip.label}
                </span>
              )
            if (chip.kind === 'project' && tokenProject)
              return (
                <span
                  key={chip.kind}
                  className={base}
                  style={{
                    color: `color-mix(in srgb, ${tokenProject.color} 60%, var(--c-ink))`,
                    background: `color-mix(in srgb, ${tokenProject.color} 14%, transparent)`,
                  }}
                >
                  {chip.label}
                </span>
              )
            return (
              <span key={chip.kind} className={`${base} bg-sunken font-mono text-muted`}>
                {chip.label}
              </span>
            )
          })}
        </div>
      )}
    </form>
  )
}
