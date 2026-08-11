import { useMemo, useState } from 'react'
import { useAuth } from '@/auth/AuthProvider'
import { LoginPage } from '@/auth/LoginPage'
import { useProjects } from '@/data/projects'
import { useTasks } from '@/data/tasks'
import { isConfigured } from '@/lib/supabase'
import { filterTasks, sortTasks, type View } from '@/lib/views'
import { CalendarPanel } from '@/ui/CalendarPanel'
import { QuickAdd } from '@/ui/QuickAdd'
import { Sidebar } from '@/ui/Sidebar'
import { TaskList } from '@/ui/TaskList'
import { useTheme } from '@/ui/useTheme'

/**
 * The OAuth callback lands back on the app with ?calendar=connected|error.
 * Read once at startup, then strip from the URL so a refresh does not replay
 * a stale banner.
 */
function readCallbackParams(): { status: string | null; detail: string | null } {
  const params = new URLSearchParams(window.location.search)
  const status = params.get('calendar')
  const detail = params.get('detail')
  if (status) {
    params.delete('calendar')
    params.delete('detail')
    const query = params.toString()
    window.history.replaceState({}, '', window.location.pathname + (query ? `?${query}` : ''))
  }
  return { status, detail }
}

const THEME_LABEL = { system: 'Авто', light: 'Светлая', dark: 'Тёмная' } as const

export function App() {
  const { session, loading } = useAuth()

  if (!isConfigured) return <SetupNotice />
  if (loading) return <Centered>Загрузка…</Centered>
  if (!session) return <LoginPage />
  return <Workspace />
}

function Workspace() {
  const { session, signOut } = useAuth()
  const [callback, setCallback] = useState(readCallbackParams)
  // Returning from Google should land on the panel that explains what happened.
  const [view, setView] = useState<View>(callback.status ? { kind: 'calendar' } : { kind: 'today' })
  const [theme, cycleTheme] = useTheme()

  const { data: tasks = [], isLoading, error } = useTasks()
  const { data: projects = [] } = useProjects()

  const visible = useMemo(() => sortTasks(filterTasks(tasks, view)), [tasks, view])

  const title =
    view.kind === 'project'
      ? (projects.find((p) => p.id === view.id)?.name ?? 'Проект')
      : {
          today: 'Сегодня',
          upcoming: 'Предстоящие',
          inbox: 'Входящие',
          all: 'Все',
          done: 'Выполненные',
          calendar: 'Календарь',
        }[view.kind]

  const empty =
    view.kind === 'today'
      ? 'На сегодня ничего нет.'
      : view.kind === 'done'
        ? 'Пока ничего не выполнено.'
        : 'Пусто. Добавьте первую задачу.'

  return (
    <div className="mx-auto flex min-h-full max-w-5xl flex-col px-4 sm:px-6">
      <header className="flex items-center justify-between gap-4 border-b border-hair py-4">
        <span className="font-mono text-[0.7rem] tracking-[0.16em] text-muted uppercase">Management</span>
        <div className="flex items-center gap-3 font-mono text-[0.68rem] text-muted">
          <button type="button" onClick={cycleTheme} className="hover:text-ink" aria-label="Сменить тему">
            {THEME_LABEL[theme]}
          </button>
          <span className="hidden truncate sm:inline" title={session?.user.email ?? ''}>
            {session?.user.email}
          </span>
          <button type="button" onClick={() => void signOut()} className="hover:text-ink">
            Выйти
          </button>
        </div>
      </header>

      <div className="flex flex-1 flex-col gap-6 py-6 sm:flex-row sm:gap-8">
        <aside className="sm:w-52 sm:shrink-0">
          <Sidebar current={view} onSelect={setView} tasks={tasks} />
        </aside>

        <main className="flex min-w-0 flex-1 flex-col gap-4">
          <div className="flex items-baseline justify-between gap-3">
            <h1 className="font-mono text-xl font-semibold tracking-tight">{title}</h1>
            {view.kind !== 'calendar' && (
              <span className="font-mono text-[0.68rem] text-faint tabular-nums">{visible.length}</span>
            )}
          </div>

          {view.kind === 'calendar' ? (
            <CalendarPanel
              callbackStatus={callback.status}
              callbackDetail={callback.detail}
              onDismissCallback={() => setCallback({ status: null, detail: null })}
            />
          ) : (
            <>
              {view.kind !== 'done' && <QuickAdd view={view} />}

              {error && (
                <p className="border border-danger px-3 py-2 text-sm text-danger">
                  Не удалось загрузить задачи: {error.message}
                </p>
              )}

              {isLoading ? (
                <p className="text-sm text-faint">Загрузка задач…</p>
              ) : (
                <TaskList tasks={visible} projects={projects} emptyMessage={empty} />
              )}
            </>
          )}
        </main>
      </div>
    </div>
  )
}

function Centered({ children }: { children: React.ReactNode }) {
  return <div className="grid min-h-full place-items-center text-sm text-muted">{children}</div>
}

function SetupNotice() {
  return (
    <div className="flex min-h-full items-center justify-center p-6">
      <div className="w-full max-w-md border border-accent bg-surface p-6">
        <p className="font-mono text-[0.68rem] tracking-[0.15em] text-accent uppercase">Нужна настройка</p>
        <h1 className="mt-3 font-mono text-lg font-semibold">Не заданы переменные Supabase</h1>
        <p className="mt-3 text-sm text-muted">
          Скопируйте <code className="font-mono text-ink">.env.example</code> в{' '}
          <code className="font-mono text-ink">.env</code> и укажите{' '}
          <code className="font-mono text-ink">VITE_SUPABASE_URL</code> и{' '}
          <code className="font-mono text-ink">VITE_SUPABASE_PUBLISHABLE_KEY</code>, затем перезапустите dev-сервер.
        </p>
      </div>
    </div>
  )
}
