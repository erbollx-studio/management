import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { supabase } from '@/lib/supabase'
import type { Project, ProjectInsert, ProjectPatch } from '@/lib/types'

export const PROJECTS_KEY = ['projects'] as const

const PALETTE = ['#3E8CA0', '#9C5F04', '#A6332A', '#2B4E72', '#4A7C59', '#7A4E8C'] as const

export function nextColor(count: number): string {
  return PALETTE[count % PALETTE.length] ?? PALETTE[0]
}

async function fetchProjects(): Promise<Project[]> {
  const { data, error } = await supabase
    .from('projects')
    .select('*')
    .is('archived_at', null)
    .order('sort_order', { ascending: true })
    .order('created_at', { ascending: true })
  if (error) throw error
  return data
}

export function useProjects() {
  return useQuery({ queryKey: PROJECTS_KEY, queryFn: fetchProjects, staleTime: 60_000 })
}

export function useCreateProject() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async (input: ProjectInsert): Promise<Project> => {
      const { data, error } = await supabase.from('projects').insert(input).select().single()
      if (error) throw error
      return data
    },
    onSettled: () => qc.invalidateQueries({ queryKey: PROJECTS_KEY }),
  })
}

export function useUpdateProject() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async ({ id, patch }: { id: string; patch: ProjectPatch }): Promise<Project> => {
      const { data, error } = await supabase.from('projects').update(patch).eq('id', id).select().single()
      if (error) throw error
      return data
    },
    onSettled: () => qc.invalidateQueries({ queryKey: PROJECTS_KEY }),
  })
}
