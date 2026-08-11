import { useState } from 'react'
import { useAuth } from './AuthProvider'

export function LoginPage() {
  const { signInWithGoogle } = useAuth()
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function handleSignIn() {
    setBusy(true)
    setError(null)
    try {
      await signInWithGoogle()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Не удалось войти')
      setBusy(false)
    }
  }

  return (
    <div className="flex min-h-full items-center justify-center p-6">
      <div className="w-full max-w-sm border border-hair bg-surface p-8">
        <p className="font-mono text-[0.68rem] tracking-[0.16em] text-muted uppercase">Management</p>
        <h1 className="mt-4 font-mono text-2xl leading-tight font-semibold tracking-tight">
          Задачи и календарь
        </h1>
        <p className="mt-3 text-sm text-muted">
          Личный планировщик с двусторонней синхронизацией Google Calendar.
        </p>

        <button
          type="button"
          onClick={handleSignIn}
          disabled={busy}
          className="mt-7 w-full border border-ink bg-ink px-4 py-2.5 text-sm font-medium text-surface transition-opacity hover:opacity-85 disabled:opacity-50"
        >
          {busy ? 'Открываем Google…' : 'Войти через Google'}
        </button>

        {error && <p className="mt-4 text-sm text-danger">{error}</p>}

        <p className="mt-6 font-mono text-[0.68rem] leading-relaxed text-faint">
          Вход в приложение. Доступ к календарю запрашивается отдельно на этапе 1.
        </p>
      </div>
    </div>
  )
}
