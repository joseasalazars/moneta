import { useEffect, useState } from 'react'
import { MonitorIcon, MoonIcon, SunIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'

type Theme = 'system' | 'light' | 'dark'
const KEY = 'ledger:theme'
const OPTIONS: [Theme, string, typeof SunIcon][] = [['system', 'System', MonitorIcon], ['light', 'Light', SunIcon], ['dark', 'Dark', MoonIcon]]
const dark = matchMedia('(prefers-color-scheme: dark)')
const read = (): Theme => { try { return (localStorage.getItem(KEY) as Theme) || 'system' } catch { return 'system' } }
const apply = (t: Theme) => document.documentElement.classList.toggle('dark', t === 'dark' || (t === 'system' && dark.matches))

// Light, dark, or follow macOS (the default). index.html applies the saved choice before the first paint.
export function ThemeToggle() {
  const [theme, setTheme] = useState(read)
  useEffect(() => {
    apply(theme)
    if (theme !== 'system') return
    const on = () => apply('system')
    dark.addEventListener('change', on)
    return () => dark.removeEventListener('change', on)
  }, [theme])
  const choose = (t: Theme) => { try { localStorage.setItem(KEY, t) } catch { /* private window: this session only */ } setTheme(t) }
  const Icon = OPTIONS.find(([t]) => t === theme)![2]
  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button variant="ghost" size="icon" aria-label={`Theme: ${theme}`} title="Theme"><Icon className="size-5" /></Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-40 p-1">
        {OPTIONS.map(([t, label, I]) => (
          <button key={t} type="button" onClick={() => choose(t)} aria-pressed={theme === t}
            className={`hover:bg-muted flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-sm ${theme === t ? 'bg-muted font-medium' : ''}`}>
            <I className="size-4" />{label}
          </button>
        ))}
      </PopoverContent>
    </Popover>
  )
}
