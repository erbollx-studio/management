import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { supabase } from '@/lib/supabase'
import { TASKS_TABLE, type Task, type TaskInsert, type TaskPatch } from '@/lib/types'

export const TASKS_KEY = ['tasks'] as const

async function fetchTasks(): Promise<Task[]> {
  const { data, error } = await supabase
    .from(TASKS_TABLE)
    .select('*')
    .is('deleted_at', null)
    .order('created_at', { ascending: false })
    .limit(2000)
  if (error) throw error
  return data
}

export function useTasks() {
  return useQuery({ queryKey: TASKS_KEY, queryFn: fetchTasks, staleTime: 30_000 })
}

export function useCreateTask() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (input: TaskInsert): Promise<Task> => {
      const { data, error } = await supabase.from(TASKS_TABLE).insert(input).select().single()
      if (error) throw error
      return data
    },
    onSettled: () => qc.invalidateQueries({ queryKey: TASKS_KEY }),
  })
}

export function useUpdateTask() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async ({ id, patch }: { id: string; patch: TaskPatch }): Promise<Task> => {
      const { data, error } = await supabase.from(TASKS_TABLE).update(patch).eq('id', id).select().single()
      if (error) throw error
      return data
    },
    // Applied locally first so checking a box feels instant; rolled back if the
    // write fails, then reconciled against the server on settle.
    onMutate: async ({ id, patch }) => {
      await qc.cancelQueries({ queryKey: TASKS_KEY })
      const previous = qc.getQueryData<Task[]>(TASKS_KEY)
      qc.setQueryData<Task[]>(TASKS_KEY, (old) => old?.map((t) => (t.id === id ? { ...t, ...patch } : t)))
      return { previous }
    },
    onError: (_err, _vars, ctx) => {
      if (ctx?.previous) qc.setQueryData(TASKS_KEY, ctx.previous)
    },
    onSettled: () => qc.invalidateQueries({ queryKey: TASKS_KEY }),
  })
}

/** Soft delete — the row stays for phase 4, which must tell "deleted here" from "never existed". */
export function useDeleteTask() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (id: string): Promise<void> => {
      const { error } = await supabase
        .from(TASKS_TABLE)
        .update({ deleted_at: new Date().toISOString() })
        .eq('id', id)
      if (error) throw error
    },
    onMutate: async (id) => {
      await qc.cancelQueries({ queryKey: TASKS_KEY })
      const previous = qc.getQueryData<Task[]>(TASKS_KEY)
      qc.setQueryData<Task[]>(TASKS_KEY, (old) => old?.filter((t) => t.id !== id))
      return { previous }
    },
    onError: (_err, _vars, ctx) => {
      if (ctx?.previous) qc.setQueryData(TASKS_KEY, ctx.previous)
    },
    onSettled: () => qc.invalidateQueries({ queryKey: TASKS_KEY }),
  })
}

/**
 * The DB enforces `(status = 'done') = (completed_at is not null)`, so the two
 * columns must always move together.
 */
export function toggleDonePatch(task: Task): TaskPatch {
  if (task.status === 'done') {
    return { status: task.scheduled_start ? 'scheduled' : 'inbox', completed_at: null }
  }
  return { status: 'done', completed_at: new Date().toISOString() }
}
