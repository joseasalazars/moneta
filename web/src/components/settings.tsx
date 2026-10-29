import { useMemo, useState } from 'react'
import { TagBadge } from '@/components/badges'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { BUILT_IN, GROUPS, type Group, categoryStyle } from '@/lib/categories'
import { useData } from '@/lib/data'

// Where idle checking money should go, for the "No idle cash in checking" health check.
function IdleCash() {
  const { settings, saveSetting } = useData()
  const [name, setName] = useState(settings.idle_cash.name)
  const [rate, setRate] = useState(String(+(settings.idle_cash.apy * 100).toFixed(2)))
  const [error, setError] = useState('')
  const [saved, setSaved] = useState(false)
  async function save() {
    setError(''); setSaved(false)
    try {
      await saveSetting('idle_cash', { name, apy: Number(rate) / 100 })
      setSaved(true)
    } catch (e) {
      setError((e as Error).message)
    }
  }
  return (
    <Card>
      <CardHeader>
        <CardTitle>Savings for idle cash</CardTitle>
        <CardDescription>When checking holds more than a month and a half of spending, the health check suggests moving the extra here.</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_8rem_auto] sm:items-end">
        <div className="grid gap-1.5"><Label htmlFor="idle-name">Account</Label><Input id="idle-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="a high-yield savings account" /></div>
        <div className="grid gap-1.5"><Label htmlFor="idle-rate">Yearly rate (%)</Label><Input id="idle-rate" type="number" step="0.01" min="0" value={rate} onChange={(e) => setRate(e.target.value)} /></div>
        <Button onClick={save}>Save</Button>
        {error && <p className="text-destructive text-sm sm:col-span-3">{error}</p>}
        {saved && <p className="text-muted-foreground text-sm sm:col-span-3">Saved.</p>}
      </CardContent>
    </Card>
  )
}

// Every category in use (plus the built-in ones): its emoji and its color group. Changes are saved per row.
function Categories() {
  const { settings, saveSetting, categories } = useData()
  const names = [...new Set([...categories, ...BUILT_IN, ...Object.keys(settings.categories)])].sort((a, b) => a.localeCompare(b))
  const [adding, setAdding] = useState('')

  const save = (name: string, emoji: string, group: Group) =>
    saveSetting('categories', { ...settings.categories, [name]: [emoji || '•', group] })
  const reset = (name: string) => {
    const next = { ...settings.categories }
    delete next[name]
    return saveSetting('categories', next)
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Categories</CardTitle>
        <CardDescription>The emoji and color group each category shows with. Groups color the charts; a category name comes from your transactions.</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-1">
        {names.map((name) => {
          const st = categoryStyle(name)
          const custom = name in settings.categories
          return (
            <div key={name} className="grid grid-cols-[3.5rem_minmax(0,1fr)_10rem_5rem] items-center gap-2 py-0.5 text-sm">
              <Input aria-label={`${name} emoji`} className="h-8 text-center" defaultValue={st.emoji} maxLength={4}
                onBlur={(e) => e.target.value !== st.emoji && save(name, e.target.value, st.group)} />
              <span className="truncate">{name}</span>
              <Select value={st.group} onValueChange={(g) => save(name, st.emoji, g as Group)}>
                <SelectTrigger aria-label={`${name} group`} className="h-8"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {Object.entries(GROUPS).map(([g, { label, color }]) => (
                    <SelectItem key={g} value={g}><span className="size-2 rounded-full" style={{ background: color }} aria-hidden />{label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {custom ? <Button size="sm" variant="outline" onClick={() => reset(name)}>Reset</Button> : <span />}
            </div>
          )
        })}
        <div className="mt-3 flex gap-2">
          <Input placeholder="New category" value={adding} onChange={(e) => setAdding(e.target.value)} className="max-w-xs" />
          <Button variant="outline" disabled={!adding.trim()} onClick={async () => { await save(adding.trim(), '🏷️', 'other'); setAdding('') }}>Add</Button>
        </div>
      </CardContent>
    </Card>
  )
}

// Rename, merge (rename into an existing tag) or delete tags everywhere. Stored as renames, so rules and edits keep
// working and any change can be undone.
function Tags() {
  const { settings, saveSetting, ledger } = useData()
  const renames = settings.tag_renames
  const counts = useMemo(() => {
    const m = new Map<string, number>()
    for (const t of ledger?.rows ?? []) for (const tag of t.tags) m.set(tag, (m.get(tag) ?? 0) + 1)
    return [...m].sort((a, b) => a[0].localeCompare(b[0]))
  }, [ledger])
  const [editing, setEditing] = useState<string | null>(null)
  const [to, setTo] = useState('')

  // Point every earlier rename that ended at `from` to the new name too, so chains (A→B, then B→C) resolve in one step.
  const change = (from: string, next: string) => {
    const out: Record<string, string> = {}
    for (const [k, v] of Object.entries(renames)) out[k] = v === from ? next : v
    out[from] = next
    for (const [k, v] of Object.entries(out)) if (k === v) delete out[k]
    return saveSetting('tag_renames', out)
  }
  const undo = (from: string) => {
    const out = { ...renames }
    delete out[from]
    return saveSetting('tag_renames', out)
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Tags</CardTitle>
        <CardDescription>Rename a tag everywhere, merge it into another by giving it that name, or delete it. Add tags on any transaction.</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-1">
        {counts.length === 0 && <p className="text-muted-foreground text-sm">No tags yet.</p>}
        {counts.map(([tag, n]) => (
          <div key={tag} className="flex min-h-9 items-center justify-between gap-3 text-sm">
            {editing === tag ? (
              <form className="flex flex-1 gap-2" onSubmit={async (e) => { e.preventDefault(); if (to.trim() && to.trim() !== tag) await change(tag, to.trim()); setEditing(null) }}>
                <Input autoFocus aria-label={`New name for ${tag}`} className="h-8 max-w-xs" value={to} onChange={(e) => setTo(e.target.value)} list="tag-names" />
                <datalist id="tag-names">{counts.map(([t]) => <option key={t} value={t} />)}</datalist>
                <Button size="sm" type="submit">Save</Button>
                <Button size="sm" type="button" variant="outline" onClick={() => setEditing(null)}>Cancel</Button>
              </form>
            ) : (
              <>
                <span className="flex items-center gap-2"><TagBadge name={tag} /><span className="text-muted-foreground text-xs">{n} transactions</span></span>
                <span className="flex gap-1.5">
                  <Button size="sm" variant="outline" onClick={() => { setEditing(tag); setTo(tag) }}>Rename</Button>
                  <Button size="sm" variant="outline" onClick={() => confirm(`Remove the tag "${tag}" from ${n} transactions?`) && change(tag, '')}>Delete</Button>
                </span>
              </>
            )}
          </div>
        ))}
        {Object.keys(renames).length > 0 && (
          <div className="mt-3 grid gap-1 border-t pt-3">
            <span className="text-muted-foreground text-xs font-medium uppercase">Changed</span>
            {Object.entries(renames).map(([from, next]) => (
              <div key={from} className="flex items-center justify-between gap-3 text-sm">
                <span>{from} → {next || <span className="text-muted-foreground">deleted</span>}</span>
                <Button size="sm" variant="outline" onClick={() => undo(from)}>Undo</Button>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  )
}

export function SettingsPage() {
  return (
    <div className="grid max-w-3xl gap-4">
      <IdleCash />
      <Tags />
      <Categories />
    </div>
  )
}
