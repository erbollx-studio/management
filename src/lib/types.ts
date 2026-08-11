export type TaskStatus = 'inbox' | 'scheduled' | 'done' | 'cancelled'

/** 0 none · 1 low · 2 medium · 3 high */
export type Priority = 0 | 1 | 2 | 3

// Declared as type aliases rather than interfaces on purpose: supabase-js
// constrains table types to `Record<string, unknown>`, and interfaces do not
// get an implicit index signature, so they fail that constraint.

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

export type Database = {
  public: {
    Tables: {
      planner_tasks: { Row: Task; Insert: TaskInsert; Update: TaskPatch; Relationships: [] }
      planner_projects: { Row: Project; Insert: ProjectInsert; Update: ProjectPatch; Relationships: [] }
    }
    Views: { [_ in never]: never }
    Functions: { [_ in never]: never }
    Enums: { [_ in never]: never }
    CompositeTypes: { [_ in never]: never }
  }
}
