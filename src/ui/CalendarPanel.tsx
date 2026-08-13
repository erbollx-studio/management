import { lazy, Suspense, useState } from 'react'
import { useConnectGoogle, useGoogleAccount } from '@/data/calendar'
import { cx } from '@/lib/cx'
import { SettingsSheet } from './calendar/SettingsSheet'
import { SyncStatus } from './calendar/SyncStatus'
import type { Task } from '@/lib/types'

// FullCalendar is ~200 KB minified; keep it out of the main bundle so the
// task views load without it.
const CalendarGrid = lazy(() =>
  import('./CalendarGrid').then((m) => ({ default: m.CalendarGrid })),
)

/** Callback failures come back as ?calendar=error&detail=… on the app URL. */
const CALLBACK_DETAIL: Record<string, string> = {
  access_denied: 'Доступ не выдан — в окне Google была нажата отмена.',
  no_refresh_token: 'Google не выдал refresh-токен. Обычно это значит, что доступ уже был выдан ранее — отзовите его в аккаунте Google и подключитесь заново.',
  state_expired: 'Сессия подключения истекла. Начните заново.',
  unknown_state: 'Не удалось сопоставить ответ Google с запросом. Начните заново.',
  token_exchange_failed: 'Google отклонил обмен кода на токен. Проверьте client ID, secret и redirect URI.',
  google_client_not_configured: 'На сервере не заданы GOOGLE_CLIENT_ID и GOOGLE_CLIENT_SECRET.',
}

/**
 * The calendar page as a working desk: a quiet toolbar (sync + settings),
 * the tray of unscheduled tasks, then the grid. Connection plumbing lives in
 * the settings sheet — only broken states stay inline where they can't hide.
 */
export function CalendarPanel({ callbackStatus, callbackDetail, onDismissCallback, tasks }: {
  callbackStatus: string | null
  callbackDetail: string | null
  onDismissCallback: () => void
  tasks: Task[]
}) {
  const { data: account, isLoading } = useGoogleAccount()
  const connect = useConnectGoogle()
  const [settingsOpen, setSettingsOpen] = useState(false)

  const connected = account?.status === 'connected'

  return (
    <div className="flex flex-col gap-4">
      {callbackStatus && (
        <div
          className={cx(
            'flex items-start justify-between gap-4 rounded-control border bg-surface px-3 py-2.5 text-sm',
            callbackStatus === 'connected' ? 'border-hair' : 'border-danger/50 text-danger',
          )}
        >
          <p className="min-w-0">
            {callbackStatus === 'connected'
              ? 'Google Calendar подключён.'
              : (CALLBACK_DETAIL[callbackDetail ?? ''] ?? `Не удалось подключить: ${callbackDetail ?? 'неизвестная ошибка'}`)}
          </p>
          <button type="button" onClick={onDismissCallback} className="shrink-0 font-mono text-xs text-faint hover:text-ink">
            ✕
          </button>
        </div>
      )}

      {isLoading ? (
        <p className="text-sm text-faint">Проверяем подключение…</p>
      ) : !account ? (
        <Disconnected onConnect={() => connect.mutate()} busy={connect.isPending} error={connect.error} />
      ) : (
        <>
          <div className="flex items-center justify-between gap-3">
            {/* Sync only makes sense against a live token; keep the row shape either way. */}
            {connected ? <SyncStatus /> : <span aria-hidden="true" />}
            <button
              type="button"
              onClick={() => setSettingsOpen(true)}
              className="shrink-0 rounded-control px-2 py-1 font-mono text-[0.7rem] text-muted transition-colors hover:bg-sunken hover:text-ink"
            >
              Настройки
            </button>
          </div>

          {/* A broken connection must not hide in a sheet — it stays inline. */}
          {account.status !== 'connected' && (
            <div className="rounded-card border border-danger/50 bg-surface px-4 py-3">
              <p className="text-sm text-danger">
                {account.last_error ?? 'Токен больше не действует.'}
              </p>
              <button
                type="button"
                onClick={() => connect.mutate()}
                disabled={connect.isPending}
                className="mt-3 rounded-control bg-accent px-3 py-1.5 text-sm font-medium text-ground transition-colors hover:bg-ink disabled:bg-hair disabled:text-faint"
              >
                Подключить заново
              </button>
            </div>
          )}
        </>
      )}

      <Suspense fallback={<p className="text-sm text-faint">Загружаем сетку…</p>}>
        <CalendarGrid connected={connected} tasks={tasks} />
      </Suspense>

      {settingsOpen && account && (
        <SettingsSheet account={account} onClose={() => setSettingsOpen(false)} />
      )}
    </div>
  )
}

function Disconnected({ onConnect, busy, error }: { onConnect: () => void; busy: boolean; error: Error | null }) {
  return (
    <div className="rounded-card border border-hair bg-surface p-5">
      <h2 className="font-serif text-lg font-semibold">Google Calendar не подключён</h2>
      <p className="mt-2 max-w-prose text-sm text-muted">
        Приложение запросит доступ к событиям календаря. Пока это только чтение списка календарей —
        задачи в календарь ещё не пишутся.
      </p>
      <button
        type="button"
        onClick={onConnect}
        disabled={busy}
        className="mt-5 rounded-control bg-accent px-4 py-2 text-sm font-medium text-ground transition-colors hover:bg-ink disabled:bg-hair disabled:text-faint"
      >
        {busy ? 'Открываем Google…' : 'Подключить Google Calendar'}
      </button>
      {error && <p className="mt-3 text-sm text-danger">{error.message}</p>}
    </div>
  )
}
