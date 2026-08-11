import { useCalendars, useConnectGoogle, useDisconnectGoogle, useGoogleAccount } from '@/data/calendar'
import { cx } from '@/lib/cx'

/** Callback failures come back as ?calendar=error&detail=… on the app URL. */
const CALLBACK_DETAIL: Record<string, string> = {
  access_denied: 'Доступ не выдан — в окне Google была нажата отмена.',
  no_refresh_token: 'Google не выдал refresh-токен. Обычно это значит, что доступ уже был выдан ранее — отзовите его в аккаунте Google и подключитесь заново.',
  state_expired: 'Сессия подключения истекла. Начните заново.',
  unknown_state: 'Не удалось сопоставить ответ Google с запросом. Начните заново.',
  token_exchange_failed: 'Google отклонил обмен кода на токен. Проверьте client ID, secret и redirect URI.',
  google_client_not_configured: 'На сервере не заданы GOOGLE_CLIENT_ID и GOOGLE_CLIENT_SECRET.',
}

export function CalendarPanel({ callbackStatus, callbackDetail, onDismissCallback }: {
  callbackStatus: string | null
  callbackDetail: string | null
  onDismissCallback: () => void
}) {
  const { data: account, isLoading } = useGoogleAccount()
  const connect = useConnectGoogle()
  const disconnect = useDisconnectGoogle()

  const connected = account?.status === 'connected'
  const calendars = useCalendars(connected)

  return (
    <div className="flex flex-col gap-4">
      {callbackStatus && (
        <div
          className={cx(
            'flex items-start justify-between gap-4 border px-3 py-2.5 text-sm',
            callbackStatus === 'connected' ? 'border-hair bg-surface' : 'border-danger',
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
        <div className="border border-hair bg-surface">
          <div className="flex flex-wrap items-start justify-between gap-3 border-b border-hair px-4 py-3">
            <div className="min-w-0">
              <p className="font-mono text-[0.68rem] tracking-[0.12em] text-muted uppercase">
                {account.status === 'connected' ? 'Подключено' : 'Требуется повторный вход'}
              </p>
              <p className="mt-1 truncate text-sm">{account.email ?? 'аккаунт Google'}</p>
              <p className="mt-0.5 font-mono text-[0.68rem] text-faint">
                с {new Date(account.connected_at).toLocaleDateString('ru')}
              </p>
            </div>
            <button
              type="button"
              onClick={() => disconnect.mutate()}
              disabled={disconnect.isPending}
              className="shrink-0 border border-hair px-2.5 py-1 font-mono text-[0.7rem] text-danger hover:border-danger disabled:opacity-50"
            >
              Отключить
            </button>
          </div>

          {account.status !== 'connected' && (
            <div className="border-b border-hair px-4 py-3">
              <p className="text-sm text-danger">
                {account.last_error ?? 'Токен больше не действует.'}
              </p>
              <button
                type="button"
                onClick={() => connect.mutate()}
                disabled={connect.isPending}
                className="mt-3 border border-ink bg-ink px-3 py-1.5 text-sm text-surface hover:opacity-85 disabled:opacity-50"
              >
                Подключить заново
              </button>
            </div>
          )}

          <div className="px-4 py-3">
            <h3 className="font-mono text-[0.65rem] tracking-[0.12em] text-muted uppercase">Календари</h3>
            {calendars.isLoading && <p className="mt-2 text-sm text-faint">Загружаем…</p>}
            {calendars.error && (
              <p className="mt-2 text-sm text-danger">
                Не удалось получить список: {calendars.error.message}
              </p>
            )}
            {calendars.data && (
              <ul className="mt-2 flex flex-col gap-1.5">
                {calendars.data.map((c) => (
                  <li key={c.id} className="flex items-center gap-2 text-sm">
                    <span
                      className="size-2 shrink-0"
                      style={{ background: c.backgroundColor ?? 'var(--c-rule)' }}
                      aria-hidden="true"
                    />
                    <span className="min-w-0 flex-1 truncate">{c.summary}</span>
                    {c.primary && (
                      <span className="shrink-0 font-mono text-[0.62rem] tracking-wider text-faint uppercase">
                        основной
                      </span>
                    )}
                  </li>
                ))}
                {calendars.data.length === 0 && (
                  <li className="text-sm text-faint">Календарей с правом записи не найдено.</li>
                )}
              </ul>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

function Disconnected({ onConnect, busy, error }: { onConnect: () => void; busy: boolean; error: Error | null }) {
  return (
    <div className="border border-hair bg-surface p-5">
      <h2 className="font-mono text-base font-semibold">Google Calendar не подключён</h2>
      <p className="mt-2 max-w-prose text-sm text-muted">
        Приложение запросит доступ к событиям календаря. Пока это только чтение списка календарей —
        задачи в календарь ещё не пишутся.
      </p>
      <button
        type="button"
        onClick={onConnect}
        disabled={busy}
        className="mt-5 border border-ink bg-ink px-4 py-2 text-sm font-medium text-surface hover:opacity-85 disabled:opacity-50"
      >
        {busy ? 'Открываем Google…' : 'Подключить Google Calendar'}
      </button>
      {error && <p className="mt-3 text-sm text-danger">{error.message}</p>}
    </div>
  )
}
