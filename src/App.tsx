import { useMemo, useState } from 'react'
import { useAuth } from '@/auth/AuthProvider'
import { LoginPage } from '@/auth/LoginPage'
import { useGoogleAccount } from '@/data/calendar'
import { useProjects } from '@/data/projects'
import { useTasks } from '@/data/tasks'
import { isConfigured } from '@/lib/supabase'
import { filterTasks, sortTasks, type View } from '@/lib/views'
import { CalendarPanel } from '@/ui/CalendarPanel'
import { CommandLayer } from '@/ui/CommandLayer'
import { QuickAdd } from '@/ui/QuickAdd'
import { Sidebar } from '@/ui/Sidebar'
import { TaskList } from '@/ui/TaskList'
import { MoreSheet } from '@/ui/shell/MoreSheet'
import { TabBar } from '@/ui/shell/TabBar'
import { TodayView } from '@/ui/today/TodayView'
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
  // Mobile-only «Ещё» bottom sheet; desktop navigation lives in the sidebar.
  const [moreOpen, setMoreOpen] = useState(false)

  const { data: tasks = [], isLoading, error } = useTasks()
  const { data: projects = [] } = useProjects()
  const { data: googleAccount } = useGoogleAccount()
  const connected = googleAccount?.status === 'connected'

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
          recurring: 'Повторяющиеся',
          review: 'Обзор',
        }[view.kind]

  const empty =
    view.kind === 'today'
      ? 'На сегодня ничего нет.'
      : view.kind === 'done'
        ? 'Пока ничего не выполнено.'
        : 'Пусто. Добавьте первую задачу.'

  // Shared task-list rendering: every non-calendar view shows QuickAdd (except
  // done) plus the filtered list. Kept as one expression so the today branch
  // below can swap to a dedicated TodayView with a one-line change.
  const taskListContent = (
    <>
      {view.kind !== 'done' && <QuickAdd view={view} />}

      {error && (
        <p className="rounded-control border border-danger/50 bg-surface px-3 py-2 text-sm text-danger">
          Не удалось загрузить задачи: {error.message}
        </p>
      )}

      {isLoading ? (
        <p className="text-sm text-faint">Загрузка задач…</p>
      ) : (
        <TaskList tasks={visible} projects={projects} emptyMessage={empty} />
      )}
    </>
  )

  return (
    <div className="mx-auto flex min-h-full max-w-5xl flex-col px-4 sm:px-6">
      <header className="flex items-center justify-between gap-4 border-b border-hair py-3 sm:py-4">
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

      {/* Bottom padding on mobile keeps content clear of the fixed tab bar. */}
      <div className="flex flex-1 flex-col gap-6 pt-6 pb-[calc(4.5rem+env(safe-area-inset-bottom))] sm:flex-row sm:gap-8 sm:pb-6">
        <aside className="hidden sm:block sm:w-52 sm:shrink-0">
          <Sidebar current={view} onSelect={setView} tasks={tasks} />
        </aside>

        <main className="flex min-w-0 flex-1 flex-col gap-4">
          {/* TodayView carries its own serif header with date and progress. */}
          {view.kind !== 'today' && (
            <div className="flex items-baseline justify-between gap-3">
              <h1 className="font-serif text-2xl font-semibold tracking-tight">{title}</h1>
              {view.kind !== 'calendar' && (
                <span className="font-mono text-[0.68rem] text-faint tabular-nums">{visible.length}</span>
              )}
            </div>
          )}

          {view.kind === 'calendar' ? (
            <CalendarPanel
              callbackStatus={callback.status}
              callbackDetail={callback.detail}
              onDismissCallback={() => setCallback({ status: null, detail: null })}
              tasks={tasks}
            />
          ) : view.kind === 'today' ? (
            <>
              {/* Quick capture stays on the command center so the `n` hotkey
                  always has a target. */}
              <QuickAdd view={view} />
              <TodayView
                tasks={tasks}
                projects={projects}
                connected={connected}
                onOpenCalendar={() => setView({ kind: 'calendar' })}
              />
            </>
          ) : (
            taskListContent
          )}
        </main>
      </div>

      <TabBar current={view} onSelect={setView} onMore={() => setMoreOpen(true)} moreOpen={moreOpen} />
      {moreOpen && <MoreSheet current={view} onSelect={setView} onClose={() => setMoreOpen(false)} />}
      <CommandLayer tasks={tasks} projects={projects} onNavigate={setView} />
    </div>
  )
}

function Centered({ children }: { children: React.ReactNode }) {
  return <div className="grid min-h-full place-items-center text-sm text-muted">{children}</div>
}

function SetupNotice() {
  return (
    <div className="flex min-h-full items-center justify-center p-6">
      <div className="w-full max-w-md rounded-card border border-hair bg-surface p-6">
        <p className="font-mono text-[0.68rem] tracking-[0.15em] text-warn uppercase">Нужна настройка</p>
        <h1 className="mt-3 font-serif text-xl font-semibold">Не заданы переменные Supabase</h1>
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
