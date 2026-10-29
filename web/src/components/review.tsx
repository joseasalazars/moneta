import { useEffect, useState } from 'react'
import { CategoryBadge, TagBadge } from '@/components/badges'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { type Rule, api } from '@/lib/api'
import { useData } from '@/lib/data'
import { TxnRow } from '@/components/txn-row'

const FIELD_LABEL: Record<string, string> = {
  name: 'Name contains', note: 'Note contains', recurring: 'Recurring contains', category: 'Category is',
}

const list = (s: string) => s.split(',').map((x) => x.trim()).filter(Boolean)

// A rule from scratch. "Category is" rules only add or remove tags (e.g. every Rent, Groceries or Car charge is
// "Essential"); the others can also set the category and a recurring name. Saving one with the same "when" replaces it.
function RuleForm({ onDone }: { onDone: () => Promise<void> }) {
  const { categories } = useData()
  const [field, setField] = useState('name')
  const [match, setMatch] = useState('')
  const [category, setCategory] = useState('')
  const [add, setAdd] = useState('')
  const [remove, setRemove] = useState('')
  const [recurring, setRecurring] = useState('')
  const [error, setError] = useState('')
  const byCategory = field === 'category'

  async function save() {
    setError('')
    try {
      await api('/api/rules', { field, match, category: byCategory ? null : category || null, recurring: byCategory ? null : recurring || null,
        tags: [...list(add), ...list(remove).map((t) => `-${t}`)] })
      setMatch(''); setCategory(''); setAdd(''); setRemove(''); setRecurring('')
      await onDone()
    } catch (e) {
      setError((e as Error).message)
    }
  }

  return (
    <div className="grid gap-3 rounded-md border p-3">
      <div className="grid gap-3 sm:grid-cols-[12rem_minmax(0,1fr)]">
        <div className="grid gap-1.5">
          <Label>When</Label>
          <Select value={field} onValueChange={setField}>
            <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
            <SelectContent>{Object.entries(FIELD_LABEL).map(([f, l]) => <SelectItem key={f} value={f}>{l}</SelectItem>)}</SelectContent>
          </Select>
        </div>
        <div className="grid gap-1.5">
          <Label>{byCategory ? 'Category' : 'Text'}</Label>
          <Input list={byCategory ? 'rule-categories' : undefined} value={match} onChange={(e) => setMatch(e.target.value)} placeholder={byCategory ? 'Groceries' : 'rideshare'} />
          <datalist id="rule-categories">{categories.map((c) => <option key={c} value={c} />)}</datalist>
        </div>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        {!byCategory && (
          <div className="grid gap-1.5">
            <Label>Set category</Label>
            <Input list="rule-categories" value={category} onChange={(e) => setCategory(e.target.value)} placeholder="Leave empty to keep it" />
          </div>
        )}
        {!byCategory && (
          <div className="grid gap-1.5"><Label>Recurring name</Label><Input value={recurring} onChange={(e) => setRecurring(e.target.value)} placeholder="Optional" /></div>
        )}
        <div className="grid gap-1.5"><Label>Add tags</Label><Input value={add} onChange={(e) => setAdd(e.target.value)} placeholder="Essential, Partner" /></div>
        <div className="grid gap-1.5"><Label>Remove tags</Label><Input value={remove} onChange={(e) => setRemove(e.target.value)} placeholder="Tags other rules would add" /></div>
      </div>
      {error && <p className="text-destructive text-sm">{error}</p>}
      <div className="flex gap-2">
        <Button onClick={save} disabled={!match.trim()}>Save rule</Button>
        <Button variant="outline" onClick={() => onDone()}>Close</Button>
      </div>
    </div>
  )
}

// New Plaid transactions Copilot never saw land here; saving an edit marks one reviewed.
export function Review() {
  const { ledger, reload } = useData()
  const [rules, setRules] = useState<Rule[]>([])
  const [adding, setAdding] = useState(false)
  const pending = ledger?.rows.filter((t) => !t.reviewed && !t.pairedWith) ?? []

  useEffect(() => { api<Rule[]>('/api/rules').then(setRules) }, [ledger])

  async function approveAll() {
    await api('/api/review', { ids: pending.map((t) => t.id) })
    await reload()
  }

  async function deleteRule(id: number) {
    await api('/api/rules/delete', { id })
    await reload()
  }

  return (
    <div className="grid gap-4">
      <Card>
        <CardHeader className="flex flex-row items-start justify-between gap-4">
          <div className="grid gap-1.5">
            <CardTitle>Transactions to review</CardTitle>
            <CardDescription>Click one to fix its category, tags or note. Saving marks it reviewed.</CardDescription>
          </div>
          {pending.length > 0 && <Button variant="outline" onClick={approveAll}>Mark all {pending.length} reviewed</Button>}
        </CardHeader>
        <CardContent className="grid">
          {pending.length === 0 && <p className="text-muted-foreground text-sm">All caught up.</p>}
          {pending.map((t) => <TxnRow key={t.id} t={t} />)}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex flex-row items-start justify-between gap-4">
          <div className="grid gap-1.5">
            <CardTitle>Rules</CardTitle>
            <CardDescription>Applied to every past and future transaction that matches. A manual edit on one transaction always wins.</CardDescription>
          </div>
          {!adding && <Button variant="outline" onClick={() => setAdding(true)}>New rule</Button>}
        </CardHeader>
        <CardContent className="grid gap-2">
          {adding && <RuleForm onDone={async () => { setAdding(false); await reload() }} />}
          {rules.length === 0 && <p className="text-muted-foreground text-sm">No rules yet. Create one here, or from a transaction with "Always use this category".</p>}
          {rules.map((r) => {
            const tags: string[] = r.tags ? JSON.parse(r.tags) : []
            return (
              <div key={r.id} className="flex items-center justify-between gap-3 text-sm">
                <div className="flex min-w-0 flex-wrap items-center gap-1.5">
                  <span className="truncate">{FIELD_LABEL[r.field] ?? r.field} <span className="font-medium">"{r.match}"</span></span>
                  {r.category && <CategoryBadge name={r.category} />}
                  {tags.filter((t) => !t.startsWith('-')).map((t) => <TagBadge key={t} name={t} />)}
                  {tags.filter((t) => t.startsWith('-')).map((t) => <span key={t} className="text-muted-foreground">removes #{t.slice(1)}</span>)}
                  {r.recurring && <span className="text-muted-foreground">→ recurring "{r.recurring}"</span>}
                </div>
                <Button size="sm" variant="outline" onClick={() => deleteRule(r.id)}>Delete</Button>
              </div>
            )
          })}
        </CardContent>
      </Card>
    </div>
  )
}
