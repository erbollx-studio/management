import { createClient } from '@supabase/supabase-js'
import type { Database } from './types'

const url = import.meta.env.VITE_SUPABASE_URL
const key = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY

/** Missing config renders a setup screen instead of a blank page. */
export const isConfigured = Boolean(url && key)

// Tables live in `planner`, not `public` -- the project's `public` schema is
// occupied by an unrelated task manager that must keep working.
export const supabase = createClient<Database, 'planner'>(url || 'https://placeholder.supabase.co', key || 'placeholder', {
  db: { schema: 'planner' },
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: true,
    flowType: 'pkce',
  },
})
