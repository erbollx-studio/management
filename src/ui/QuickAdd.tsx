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
        className="min-w-0 flex-1 rounded-control border border-rule bg-field px-3 py-2 text-sm placeholder:text-faint focus:border-accent focus:ring-[3px] focus:ring-accent/10 focus:outline-none"
      />
      <button
        type="submit"
        disabled={!title.trim() || create.isPending}
        className="shrink-0 rounded-control bg-accent px-4 py-2 text-sm font-medium text-ground transition-colors hover:bg-ink disabled:bg-hair disabled:text-faint"
      >
        Добавить
      </button>
    </form>
  )
}
