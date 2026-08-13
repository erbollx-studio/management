import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { supabase } from '@/lib/supabase'
import { GOOGLE_ACCOUNTS_TABLE, type GoogleAccount } from '@/lib/types'

export const GOOGLE_ACCOUNT_KEY = ['google-account'] as const
export const CALENDARS_KEY = ['google-calendars'] as const

export interface GoogleCalendar {
  id: string
  summary: string
  primary: boolean
  timeZone: string | null
  backgroundColor: string | null
  accessRole: string
}

/** Connection state is a plain table read — no secrets live in this row. */
export function useGoogleAccount() {
  return useQuery({
    queryKey: GOOGLE_ACCOUNT_KEY,
    queryFn: async (): Promise<GoogleAccount | null> => {
      const { data, error } = await supabase.from(GOOGLE_ACCOUNTS_TABLE).select('*').maybeSingle()
      if (error) throw error
      return data
    },
    staleTime: 30_000,
  })
}

export function useConnectGoogle() {
  return useMutation({
    mutationFn: async (): Promise<void> => {
      const { data, error } = await supabase.functions.invoke<{ url: string }>('google-calendar/start', {
        method: 'POST',
      })
      if (error) throw error
      if (!data?.url) throw new Error('Сервер не вернул ссылку авторизации')
      // Full navigation, not a popup: Google blocks consent in many embedded contexts.
      window.location.assign(data.url)
    },
  })
}

export function useDisconnectGoogle() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (): Promise<void> => {
      const { error } = await supabase.functions.invoke('google-calendar/disconnect', { method: 'POST' })
      if (error) throw error
    },
    onSettled: () => {
      qc.invalidateQueries({ queryKey: GOOGLE_ACCOUNT_KEY })
      qc.removeQueries({ queryKey: CALENDARS_KEY })
    },
  })
}

/**
 * Listing calendars is the phase 1 proof of life: it exercises the stored
 * refresh token end to end, so a token that has quietly died shows up here.
 */
export function useCalendars(enabled: boolean) {
  return useQuery({
    queryKey: CALENDARS_KEY,
    enabled,
    retry: false,
    staleTime: 5 * 60_000,
    queryFn: async (): Promise<GoogleCalendar[]> => {
      const { data, error } = await supabase.functions.invoke<{ calendars: GoogleCalendar[] }>(
        'google-calendar/calendars',
        { method: 'GET' },
      )
      if (error) throw error
      return data?.calendars ?? []
    },
  })
}
