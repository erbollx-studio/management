export type TaskStatus = 'inbox' | 'scheduled' | 'done' | 'cancelled'

/** 0 none · 1 low · 2 medium · 3 high */
export type Priority = 0 | 1 | 2 | 3

// Declared as type aliases rather than interfaces on purpose: supabase-js
// constrains table types to `Record<string, unknown>`, and interfaces do not
// get an implicit index signature, so they fail that constraint.

export type EnergyLevel = 'light' | 'heavy'

export type Task = {
  id: string
  user_id: string
  project_id: string | null
  title: string
  notes: string | null
  status: TaskStatus
  priority: Priority
  estimate_minutes: number | null
  due_at: string | null
  scheduled_start: string | null
  scheduled_end: string | null
  completed_at: string | null
  gcal_event_id: string | null
  gcal_etag: string | null
  sort_order: number
  energy: EnergyLevel | null
  template_id: string | null
  local_updated_at: string
  created_at: string
  updated_at: string
  deleted_at: string | null
}

export type Project = {
  id: string
  user_id: string
  name: string
  color: string
  sort_order: number
  archived_at: string | null
  created_at: string
  updated_at: string
}

/** Columns the server fills in: id, ownership, and the bookkeeping clocks. */
type ServerManaged = 'id' | 'user_id' | 'created_at' | 'updated_at' | 'local_updated_at'

export type TaskInsert = Partial<Omit<Task, ServerManaged>> & Pick<Task, 'title'>
export type TaskPatch = Partial<Omit<Task, ServerManaged>>

export type ProjectInsert = Partial<Omit<Project, ServerManaged>> & Pick<Project, 'name'>
export type ProjectPatch = Partial<Omit<Project, ServerManaged>>

/**
 * The `planner_` prefix is the namespace: this project's `public` schema is
 * shared with an unrelated task manager that owns the unprefixed `tasks`.
 */
export const TASKS_TABLE = 'planner_tasks' as const
export const PROJECTS_TABLE = 'planner_projects' as const
export const GOOGLE_ACCOUNTS_TABLE = 'planner_google_accounts' as const
export const CALENDAR_EVENTS_TABLE = 'planner_calendar_events' as const
export const TEMPLATES_TABLE = 'planner_task_templates' as const

export type GoogleConnectionStatus = 'connected' | 'needs_reauth' | 'revoked'

/**
 * Connection metadata only. The refresh token lives in Vault and the access
 * token in a table the client holds no grant on — neither is reachable here.
 */
export type GoogleAccount = {
  user_id: string
  google_sub: string
  email: string | null
  scopes: string
  status: GoogleConnectionStatus
  connected_at: string
  last_health_check_at: string | null
  last_error: string | null
  updated_at: string
}

/** Recurring template: generates one task per matching day at 00:05 UTC. */
export type TaskTemplate = {
  id: string
  user_id: string
  title: string
  notes: string | null
  project_id: string | null
  priority: Priority
  estimate_minutes: number | null
  energy: EnergyLevel | null
  repeat_rule: 'daily' | 'weekdays' | 'custom'
  custom_days: number[] | null
  due_time: string | null
  active: boolean
  created_at: string
  updated_at: string
}

export type TemplateInsert = Partial<Omit<TaskTemplate, ServerManaged>> & Pick<TaskTemplate, 'title'>
export type TemplatePatch = Partial<Omit<TaskTemplate, ServerManaged>>

/** Read-only mirror row of a Google Calendar event; written only by the sync worker. */
export type CalendarEvent = {
  user_id: string
  gcal_event_id: string
  calendar_id: string
  etag: string | null
  summary: string | null
  start_at: string | null
  end_at: string | null
  is_all_day: boolean
  status: string
  html_link: string | null
  remote_updated_at: string | null
  owned_by_app: boolean
  raw: Record<string, unknown> | null
  synced_at: string
}

export type Database = {
  public: {
    Tables: {
      planner_tasks: { Row: Task; Insert: TaskInsert; Update: TaskPatch; Relationships: [] }
      planner_projects: { Row: Project; Insert: ProjectInsert; Update: ProjectPatch; Relationships: [] }
      planner_google_accounts: {
        Row: GoogleAccount
        Insert: Partial<GoogleAccount>
        Update: Partial<GoogleAccount>
        Relationships: []
      }
      planner_calendar_events: {
        Row: CalendarEvent
        Insert: Partial<CalendarEvent>
        Update: Partial<CalendarEvent>
        Relationships: []
      }
      planner_task_templates: {
        Row: TaskTemplate
        Insert: TemplateInsert
        Update: TemplatePatch
        Relationships: []
      }
    }
    Views: { [_ in never]: never }
    Functions: { [_ in never]: never }
    Enums: { [_ in never]: never }
    CompositeTypes: { [_ in never]: never }
  }
}
