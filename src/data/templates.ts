import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { supabase } from '@/lib/supabase'
import { TASKS_KEY } from '@/data/tasks'
import { TEMPLATES_TABLE, type TaskTemplate, type TemplateInsert, type TemplatePatch } from '@/lib/types'

export const TEMPLATES_KEY = ['templates'] as const

async function fetchTemplates(): Promise<TaskTemplate[]> {
  // RLS scopes rows to the signed-in user; active templates surface first.
  const { data, error } = await supabase
    .from(TEMPLATES_TABLE)
    .select('*')
    .order('active', { ascending: false })
    .order('created_at', { ascending: false })
  if (error) throw error
  return data
}

export function useTemplates() {
  return useQuery({ queryKey: TEMPLATES_KEY, queryFn: fetchTemplates, staleTime: 30_000 })
}

export function useCreateTemplate() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (input: TemplateInsert): Promise<TaskTemplate> => {
      const { data, error } = await supabase.from(TEMPLATES_TABLE).insert(input).select().single()
      if (error) throw error
      return data
    },
    onSettled: () => qc.invalidateQueries({ queryKey: TEMPLATES_KEY }),
  })
}

export function useUpdateTemplate() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async ({ id, patch }: { id: string; patch: TemplatePatch }): Promise<TaskTemplate> => {
      const { data, error } = await supabase
        .from(TEMPLATES_TABLE)
        .update(patch)
        .eq('id', id)
        .select()
        .single()
      if (error) throw error
      return data
    },
    // Applied locally first so the active toggle flips instantly; rolled back
    // if the write fails, then reconciled against the server on settle.
    onMutate: async ({ id, patch }) => {
      await qc.cancelQueries({ queryKey: TEMPLATES_KEY })
      const previous = qc.getQueryData<TaskTemplate[]>(TEMPLATES_KEY)
      qc.setQueryData<TaskTemplate[]>(TEMPLATES_KEY, (old) =>
        old?.map((t) => (t.id === id ? { ...t, ...patch } : t)),
      )
      return { previous }
    },
    onError: (_err, _vars, ctx) => {
      if (ctx?.previous) qc.setQueryData(TEMPLATES_KEY, ctx.previous)
    },
    onSettled: () => qc.invalidateQueries({ queryKey: TEMPLATES_KEY }),
  })
}

/** Hard delete — templates carry no history worth keeping; generated tasks live on. */
export function useDeleteTemplate() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (id: string): Promise<void> => {
      const { error } = await supabase.from(TEMPLATES_TABLE).delete().eq('id', id)
      if (error) throw error
    },
    onMutate: async (id) => {
      await qc.cancelQueries({ queryKey: TEMPLATES_KEY })
      const previous = qc.getQueryData<TaskTemplate[]>(TEMPLATES_KEY)
      qc.setQueryData<TaskTemplate[]>(TEMPLATES_KEY, (old) => old?.filter((t) => t.id !== id))
      return { previous }
    },
    onError: (_err, _vars, ctx) => {
      if (ctx?.previous) qc.setQueryData(TEMPLATES_KEY, ctx.previous)
    },
    onSettled: () => qc.invalidateQueries({ queryKey: TEMPLATES_KEY }),
  })
}

// The generated Database type declares no Functions, so the client's rpc()
// signature rejects every name — narrow just this one call by hand instead of
// widening the whole schema type.
type GenerateRecurringRpc = (
  fn: 'planner_generate_recurring',
  args: { p_user_id: string },
) => PromiseLike<{ data: number | null; error: Error | null }>

/**
 * Runs today's generation on demand (the same routine cron fires at 00:05 UTC)
 * and resolves with how many tasks were created. Idempotent server-side, so
 * re-running it never duplicates tasks.
 */
export function useGenerateNow() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (): Promise<number> => {
      const { data: auth, error: authError } = await supabase.auth.getUser()
      if (authError) throw authError
      if (!auth.user) throw new Error('Нет активной сессии')
      const rpc = supabase.rpc.bind(supabase) as unknown as GenerateRecurringRpc
      const { data, error } = await rpc('planner_generate_recurring', { p_user_id: auth.user.id })
      if (error) throw error
      return data ?? 0
    },
    // Fresh tasks land in planner_tasks — refetch the task list, not templates.
    onSettled: () => qc.invalidateQueries({ queryKey: TASKS_KEY }),
  })
}
