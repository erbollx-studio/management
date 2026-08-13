import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { supabase } from '@/lib/supabase'
import { CALENDAR_EVENTS_TABLE, type CalendarEvent } from '@/lib/types'

export const EVENTS_KEY = ['calendar-events'] as const

/**
 * Reads the local mirror only — never Google directly. The mirror is refreshed
 * by the sync route; the browser's job is to render what Postgres already has.
 */
export function useCalendarEvents(from: Date, to: Date, enabled: boolean) {
  return useQuery({
    queryKey: [...EVENTS_KEY, from.toISOString().slice(0, 10), to.toISOString().slice(0, 10)],
    enabled,
    staleTime: 60_000,
    queryFn: async (): Promise<CalendarEvent[]> => {
      const { data, error } = await supabase
        .from(CALENDAR_EVENTS_TABLE)
        .select('*')
        .neq('status', 'cancelled')
        .gte('start_at', from.toISOString())
        .lt('start_at', to.toISOString())
        .order('start_at', { ascending: true })
        .limit(1000)
      if (error) throw error
      return data
    },
  })
}

/**
 * App-owned mirror rows carry the planner task id inside Google's private
 * extended properties — that link is what lets a dragged event find its task.
 */
export function taskIdOfEvent(e: CalendarEvent): string | null {
  const raw = e.raw as { extendedProperties?: { private?: { plannerTaskId?: unknown } } } | null
  const id = raw?.extendedProperties?.private?.plannerTaskId
  return typeof id === 'string' && id ? id : null
}

/** Fire the incremental pull, then re-read whatever window is on screen. */
export function useSyncNow() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (): Promise<{ ok: boolean; full: boolean; changed: number }> => {
      const { data, error } = await supabase.functions.invoke<{ ok: boolean; full: boolean; changed: number }>(
        'google-calendar/sync',
        { method: 'POST' },
      )
      if (error) throw error
      return data ?? { ok: false, full: false, changed: 0 }
    },
    onSettled: () => qc.invalidateQueries({ queryKey: EVENTS_KEY }),
  })
}
