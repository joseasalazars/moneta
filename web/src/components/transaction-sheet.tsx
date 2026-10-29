import { useEffect, useState } from 'react'
import { XIcon } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Sheet, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { SplitEditor } from '@/components/split-editor'
import { type Txn, api, money, todayISO } from '@/lib/api'
import { useData } from '@/lib/data'

type Form = {
  date: string; name: string; amount: string; account: string; type: Txn['type']
  category: string; tags: string[]; note: string; recurring: string; excluded: boolean
}

const toForm = (t: Txn | null): Form => ({
  date: t?.date ?? todayISO(),
  name: t?.name ?? '',
  amount: t ? String(t.amount) : '',
  account: t?.account ?? '',
  type: t?.type ?? 'regular',
  category: t?.category ?? '',
  tags: t?.tags ?? [],
  note: t?.note ?? '',
  recurring: t?.recurring ?? '',
  excluded: t?.excluded ?? false,
})

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <div className="grid gap-1.5"><Label>{label}</Label>{children}</div>
}

// Tags are free-form groups; a transaction can be in several at once (e.g. "Partner" + "Trip to Mexico").
function TagInput({ value, onChange, suggestions }: { value: string[]; onChange: (v: string[]) => void; suggestions: string[] }) {
  const [draft, setDraft] = useState('')
  const add = (raw: string) => {
    const tag = raw.trim()
    if (tag && !value.includes(tag)) onChange([...value, tag])
    setDraft('')
  }
  return (
    <div className="grid gap-2">
      {value.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {value.map((t) => (
            <Badge key={t} variant="secondary" className="gap-1">
              {t}
              <button type="button" aria-label={`Remove ${t}`} onClick={() => onChange(value.filter((x) => x !== t))}>
                <XIcon className="size-3" />
              </button>
            </Badge>
          ))}
        </div>
      )}
      <Input
        list="tag-options"
        placeholder="Add a tag, press Enter"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); add(draft) }
        }}
        onBlur={() => draft && add(draft)}
      />
      <datalist id="tag-options">{suggestions.filter((s) => !value.includes(s)).map((s) => <option key={s} value={s} />)}</datalist>
    </div>
  )
}

export function TransactionSheet() {
  const { editing, setEditing, categories, tags, accounts, recurrings, reload, setStatus } = useData()
  const txn = editing === 'new' ? null : editing
  const manual = editing === 'new' || txn?.source === 'manual'
  const [form, setForm] = useState<Form>(toForm(txn))
  const [always, setAlways] = useState(false)
  const [ruleTags, setRuleTags] = useState(false)
  const [match, setMatch] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [splitting, setSplitting] = useState(false)

  useEffect(() => {
    setForm(toForm(txn))
    setSplitting(false)
    setAlways(false)
    setRuleTags(false)
    setMatch(txn?.name.toLowerCase() ?? '')
    setError('')
  }, [txn])

  const set = <K extends keyof Form>(k: K, v: Form[K]) => setForm((f) => ({ ...f, [k]: v }))

  async function save() {
    setSaving(true)
    setError('')
    try {
      if (manual) {
        await api('/api/manual/transaction', {
          id: txn?.id, date: form.date, name: form.name, amount: form.amount, account: form.account, type: form.type,
          category: form.category, tags: form.tags, note: form.note, recurring: form.recurring,
        })
      } else if (txn) {
        // Send only what changed, so untouched fields keep following rules and Copilot history.
        const initial = toForm(txn)
        const changed: Record<string, unknown> = { id: txn.id, reviewed: true }
        for (const k of ['name', 'category', 'note', 'recurring', 'excluded', 'type'] as const) {
          if (form[k] !== initial[k]) changed[k] = form[k]
        }
        if (form.tags.join('\n') !== initial.tags.join('\n')) changed.tags = form.tags
        if ((txn.source === 'copilot' || txn.source === 'split') && form.amount !== initial.amount) changed.amount = form.amount
        // Rules are retroactive, so tags only go into one when asked (tagging one dinner "Partner" shouldn't tag every visit).
        if (always && match.trim()) changed.rule = { match: match.trim(), category: form.category || null, tags: ruleTags ? form.tags : [], recurring: form.recurring || null }
        await api('/api/edit', changed)
      }
      await reload()
      setEditing(null)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setSaving(false)
    }
  }

  async function remove() {
    if (!txn || !confirm(`Delete "${txn.name}"?`)) return
    await api('/api/manual/transaction/delete', { id: txn.id })
    await reload()
    setEditing(null)
    setStatus(`Deleted ${txn.name}`)
  }

  const accountNames = [...new Set(accounts.map((a) => a.name))]

  return (
    <Sheet open={editing !== null} onOpenChange={(open) => !open && setEditing(null)}>
      <SheetContent className="w-full overflow-y-auto sm:max-w-md">
        <SheetHeader>
          <SheetTitle>{txn ? txn.name : 'Add transaction'}</SheetTitle>
          <SheetDescription>
            {txn ? `${txn.date} · ${txn.account} · ${money(-txn.amount)} · from ${txn.source}` : 'Cash, Apple Card, or anything not synced'}
          </SheetDescription>
        </SheetHeader>

        {txn && splitting ? (
          <div className="px-4 pb-4"><SplitEditor txn={txn} onDone={() => { setSplitting(false); setEditing(null) }} /></div>
        ) : (<>
        <div className="grid gap-4 px-4">
          {txn?.splitOf && (
            <p className="bg-muted rounded-md px-3 py-2 text-sm">
              Part of a split. <button type="button" className="underline underline-offset-2" onClick={() => setSplitting(true)}>Edit the split</button>
            </p>
          )}
          {manual && (
            <>
              <div className="grid grid-cols-2 gap-3">
                <Field label="Date"><Input type="date" value={form.date} onChange={(e) => set('date', e.target.value)} /></Field>
                <Field label="Amount (+ out, − in)">
                  <Input type="number" step="0.01" inputMode="decimal" value={form.amount} onChange={(e) => set('amount', e.target.value)} />
                </Field>
              </div>
              <Field label="Account">
                <Input list="account-options" value={form.account} onChange={(e) => set('account', e.target.value)} placeholder="Apple Card" />
                <datalist id="account-options">{accountNames.map((a) => <option key={a} value={a} />)}</datalist>
              </Field>
            </>
          )}
          {(txn?.source === 'copilot' || txn?.source === 'split') && (
            // Copilot history can hold manual entries with typos; Plaid amounts come from the bank and stay read-only.
            <Field label="Amount (+ out, − in)">
              <Input type="number" step="0.01" inputMode="decimal" value={form.amount} onChange={(e) => set('amount', e.target.value)} />
            </Field>
          )}
          <Field label="Name">
            <Input value={form.name} onChange={(e) => set('name', e.target.value)} />
          </Field>
          <Field label="Type">
            <Select value={form.type} onValueChange={(v) => set('type', v as Txn['type'])}>
              <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="regular">Expense / refund</SelectItem>
                <SelectItem value="income">Income</SelectItem>
                <SelectItem value="internal transfer">Transfer between my accounts</SelectItem>
              </SelectContent>
            </Select>
          </Field>
          <Field label="Category">
            <Input list="category-options" value={form.category} onChange={(e) => set('category', e.target.value)} />
            <datalist id="category-options">{categories.map((c) => <option key={c} value={c} />)}</datalist>
          </Field>
          <Field label="Tags">
            <TagInput value={form.tags} onChange={(v) => set('tags', v)} suggestions={tags} />
          </Field>
          <Field label="Recurring">
            <Input list="recurring-options" value={form.recurring} onChange={(e) => set('recurring', e.target.value)} placeholder="None" />
            <datalist id="recurring-options">{recurrings.map((r) => <option key={r.name} value={r.name} />)}</datalist>
          </Field>
          <Field label="Note">
            <Textarea value={form.note} onChange={(e) => set('note', e.target.value)} rows={2} />
          </Field>
          {!manual && (
            <div className="flex items-center justify-between gap-3">
              <Label htmlFor="excluded">Exclude from spending and income</Label>
              <Switch id="excluded" checked={form.excluded} onCheckedChange={(v) => set('excluded', v)} />
            </div>
          )}
          {txn && !manual && (
            <div className="grid gap-2 rounded-md border p-3">
              <div className="flex items-center gap-2">
                <Checkbox id="always" checked={always} onCheckedChange={(v) => setAlways(v === true)} />
                <Label htmlFor="always">Always use this category{form.recurring && ' and recurring'} for names containing</Label>
              </div>
              <Input value={match} onChange={(e) => setMatch(e.target.value)} disabled={!always} />
              {always && form.tags.length > 0 && (
                <div className="flex items-center gap-2">
                  <Checkbox id="rule-tags" checked={ruleTags} onCheckedChange={(v) => setRuleTags(v === true)} />
                  <Label htmlFor="rule-tags">Also add tags {form.tags.join(', ')} to all of them</Label>
                </div>
              )}
              <p className="text-muted-foreground text-xs">Applies to past and future transactions. Manage rules on the Review page.</p>
            </div>
          )}
          {error && <p className="text-destructive text-sm">{error}</p>}
        </div>

        <SheetFooter>
          <Button onClick={save} disabled={saving}>{saving ? 'Saving…' : 'Save'}</Button>
          {txn && !txn.splitOf && <Button variant="outline" onClick={() => setSplitting(true)}>Split</Button>}
          {txn?.source === 'manual' && <Button variant="destructive" onClick={remove}>Delete</Button>}
          <Button variant="outline" onClick={() => setEditing(null)}>Cancel</Button>
        </SheetFooter>
        </>)}
      </SheetContent>
    </Sheet>
  )
}
