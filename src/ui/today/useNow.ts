import { useEffect, useState } from 'react'

/**
 * Re-renders once a minute so every "now"-derived boundary (past/current/next
 * rows, the now rule, the overdue split) stays honest while the view sits
 * open. Minute granularity matches the finest time we ever display (HH:MM).
 */
export function useNow(intervalMs = 60_000): Date {
  const [now, setNow] = useState(() => new Date())
  useEffect(() => {
    const id = window.setInterval(() => setNow(new Date()), intervalMs)
    return () => window.clearInterval(id)
  }, [intervalMs])
  return now
}
