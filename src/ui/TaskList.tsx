import { useDeleteTask, toggleDonePatch, useUpdateTask } from '@/data/tasks'
import type { Project, Task } from '@/lib/types'
import { TaskItem } from './TaskItem'

interface Props {
  tasks: Task[]
  projects: Project[]
  emptyMessage: string
}

export function TaskList({ tasks, projects, emptyMessage }: Props) {
  const update = useUpdateTask()
  const remove = useDeleteTask()

  if (tasks.length === 0) {
    return (
      <div className="rounded-card border border-dashed border-rule px-4 py-10 text-center text-sm text-faint">
        {emptyMessage}
      </div>
    )
  }

  return (
    <ul className="overflow-hidden rounded-card border border-hair bg-surface">
      {tasks.map((task) => (
        <TaskItem
          key={task.id}
          task={task}
          projects={projects}
          onPatch={(patch) => update.mutate({ id: task.id, patch })}
          onToggleDone={() => update.mutate({ id: task.id, patch: toggleDonePatch(task) })}
          onDelete={() => remove.mutate(task.id)}
        />
      ))}
    </ul>
  )
}
