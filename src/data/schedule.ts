import { useMutation, useQueryClient } from '@tanstack/react-query'
import { supabase } from '@/lib/supabase'
import { TASKS_TABLE, type Task } from '@/lib/types'
import { TASKS_KEY } from './tasks'
import { EVENTS_KEY } from './events'

/** A drop with no estimate books a round hour — enough to be visible, cheap to resize. */
export const DEFAULT_SLOT_MINUTES = 60

export function defaultEnd(start: Date, estimateMinutes: number | null): Date {
  return new Date(start.getTime() + (estimateMinutes ?? DEFAULT_SLOT_MINUTES) * 60_000)
}

/**
 * The DB trigger has already enqueued the Google write; the drain call only
 * shortens the wait, so failures are safe to swallow and the UI never blocks.
 */
function nudgeDrain() {
  supabase.functions.invoke('google-calendar/drain', { method: 'POST' }).catch(() => {})
}

export function useScheduleTask() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async ({ taskId, start, end }: { taskId: string; start: Date; end: Date }): Promise<Task> => {
      const { data, error } = await supabase
        .from(TASKS_TABLE)
        .update({
          scheduled_start: start.toISOString(),
          scheduled_end: end.toISOString(),
          status: 'scheduled',
        })
        .eq('id', taskId)
        .select()
        .single()
      if (error) throw error
      nudgeDrain()
      return data
    },
    // Applied locally first so the drop lands instantly; rolled back if the
    // write fails, then reconciled against the server on settle.
    onMutate: async ({ taskId, start, end }) => {
      await qc.cancelQueries({ queryKey: TASKS_KEY })
      const previous = qc.getQueryData<Task[]>(TASKS_KEY)
      qc.setQueryData<Task[]>(TASKS_KEY, (old) =>
        old?.map((t) =>
          t.id === taskId
            ? {
                ...t,
                scheduled_start: start.toISOString(),
                scheduled_end: end.toISOString(),
                status: 'scheduled' as const,
              }
            : t,
        ),
      )
      return { previous }
    },
    onError: (_err, _vars, ctx) => {
      if (ctx?.previous) qc.setQueryData(TASKS_KEY, ctx.previous)
    },
    onSettled: () => {
      qc.invalidateQueries({ queryKey: TASKS_KEY })
      qc.invalidateQueries({ queryKey: EVENTS_KEY })
    },
  })
}

export function useUnscheduleTask() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (taskId: string): Promise<Task> => {
      const { data, error } = await supabase
        .from(TASKS_TABLE)
        .update({ scheduled_start: null, scheduled_end: null, status: 'inbox' })
        .eq('id', taskId)
        .select()
        .single()
      if (error) throw error
      nudgeDrain()
      return data
    },
    onMutate: async (taskId) => {
      await qc.cancelQueries({ queryKey: TASKS_KEY })
      const previous = qc.getQueryData<Task[]>(TASKS_KEY)
      qc.setQueryData<Task[]>(TASKS_KEY, (old) =>
        old?.map((t) =>
          t.id === taskId
            ? { ...t, scheduled_start: null, scheduled_end: null, status: 'inbox' as const }
            : t,
        ),
      )
      return { previous }
    },
    onError: (_err, _vars, ctx) => {
      if (ctx?.previous) qc.setQueryData(TASKS_KEY, ctx.previous)
    },
    onSettled: () => {
      qc.invalidateQueries({ queryKey: TASKS_KEY })
      qc.invalidateQueries({ queryKey: EVENTS_KEY })
    },
  })
}
