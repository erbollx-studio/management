import { useEffect, useState } from 'react'

export type ThemeChoice = 'system' | 'light' | 'dark'

const STORAGE_KEY = 'management:theme'
const ORDER: ThemeChoice[] = ['system', 'light', 'dark']

function read(): ThemeChoice {
  const stored = localStorage.getItem(STORAGE_KEY)
  return stored === 'light' || stored === 'dark' ? stored : 'system'
}

/**
 * "system" leaves the root unstamped so prefers-color-scheme decides; an
 * explicit choice stamps data-theme, which the CSS gives priority over the
 * media query in both directions.
 */
export function useTheme(): [ThemeChoice, () => void] {
  const [choice, setChoice] = useState<ThemeChoice>(read)

  useEffect(() => {
    const root = document.documentElement
    if (choice === 'system') root.removeAttribute('data-theme')
    else root.setAttribute('data-theme', choice)
    localStorage.setItem(STORAGE_KEY, choice)
  }, [choice])

  const cycle = () => setChoice((c) => ORDER[(ORDER.indexOf(c) + 1) % ORDER.length] ?? 'system')
  return [choice, cycle]
}
