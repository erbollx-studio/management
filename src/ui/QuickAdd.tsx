import { useState, type FormEvent } from 'react'
import { useCreateTask } from '@/data/tasks'
import type { View } from '@/lib/views'

export function QuickAdd({ view }: { view: View }) {
  const [title, setTitle] = useState('')
  const create = useCreateTask()

  function handleSubmit(e: FormEvent) {
    e.preventDefault()
    const trimmed = title.trim()
    if (!trimmed) return
    // A task added inside a project view belongs to that project.
    create.mutate({ title: trimmed, project_id: view.kind === 'project' ? view.id : null })
    setTitle('')
  }

  return (
    <form onSubmit={handleSubmit} className="flex gap-2">
      <input
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        placeholder="Новая задача…"
        aria-label="Название новой задачи"
        className="min-w-0 flex-1 border border-hair bg-surface px-3 py-2.5 text-sm placeholder:text-faint focus:border-rule focus:outline-none"
      />
      <button
        type="submit"
        disabled={!title.trim() || create.isPending}
        className="shrink-0 border border-ink bg-ink px-4 py-2.5 text-sm font-medium text-surface transition-opacity hover:opacity-85 disabled:opacity-40"
      >
        Добавить
      </button>
    </form>
  )
}
