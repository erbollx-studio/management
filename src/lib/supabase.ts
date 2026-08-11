import { createClient } from '@supabase/supabase-js'
import type { Database } from './types'

const url = import.meta.env.VITE_SUPABASE_URL
const key = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY

/** Missing config renders a setup screen instead of a blank page. */
export const isConfigured = Boolean(url && key)

export const supabase = createClient<Database>(url || 'https://placeholder.supabase.co', key || 'placeholder', {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: true,
    flowType: 'pkce',
  },
})
