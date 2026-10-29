import { useState } from 'react'
import { XIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { type Txn, api, money } from '@/lib/api'
import { useData } from '@/lib/data'

type Part = { name: string; amount: string; category: string; tags: string }
const cents = (s: string) => Math.round(Number(s || 0) * 100)

// Split one bank transaction into parts (e.g. $100 → Clinic $50 + Salon $50). Starts from the existing parts
// when the transaction is already split, otherwise from two halves with the original category and tags.
export function SplitEditor({ txn, onDone }: { txn: Txn; onDone: () => void }) {
  const { ledger, categories, reload } = useData()
  const parentId = txn.splitOf ?? txn.id
  const existing = (ledger?.rows ?? []).filter((r) => r.splitOf === parentId).sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }))
  const total = existing.length ? existing.reduce((s, r) => s + cents(String(r.amount)), 0) : cents(String(txn.amount))
  const half = Math.round(total / 2)
  const [parts, setParts] = useState<Part[]>(existing.length
    ? existing.map((r) => ({ name: r.name, amount: String(r.amount), category: r.category, tags: r.tags.join(', ') }))
    // Tags start empty: rules add the right ones per part (Essential for Groceries, Lifestyle for Home...).
    : [half, total - half].map((c) => ({ name: txn.name, amount: (c / 100).toFixed(2), category: txn.category, tags: '' })))
  const [error, setError] = useState('')
  const left = total - parts.reduce((s, p) => s + cents(p.amount), 0)

  const set = (i: number, k: keyof Part, v: string) => setParts((ps) => ps.map((p, j) => (j === i ? { ...p, [k]: v } : p)))

  async function save() {
    setError('')
    try {
      await api('/api/split', {
        id: parentId,
        parts: parts.map((p) => ({ ...p, tags: p.tags.split(',').map((t) => t.trim()).filter(Boolean) })),
      })
      await reload()
      onDone()
    } catch (e) {
      setError((e as Error).message)
    }
  }

  async function undo() {
    if (!confirm('Undo this split and go back to one transaction?')) return
    await api('/api/split/delete', { id: parentId })
    await reload()
    onDone()
  }

  return (
    <div className="grid gap-4">
      <p className="text-muted-foreground text-sm">Total {money(-total / 100)}. Each part gets its own name, category and tags; together they must add up to the total.</p>
      {parts.map((p, i) => (
        <div key={i} className="grid gap-2 rounded-md border p-3">
          <div className="flex items-center justify-between">
            <Label>Part {i + 1}</Label>
            {parts.length > 2 && (
              <Button size="icon" variant="ghost" className="size-7" aria-label={`Remove part ${i + 1}`} onClick={() => setParts(parts.filter((_, j) => j !== i))}>
                <XIcon className="size-4" />
              </Button>
            )}
          </div>
          <div className="grid grid-cols-[1fr_7rem] gap-2">
            <Input aria-label={`Part ${i + 1} name`} value={p.name} onChange={(e) => set(i, 'name', e.target.value)} placeholder="Name" />
            <Input aria-label={`Part ${i + 1} amount`} type="number" step="0.01" inputMode="decimal" value={p.amount} onChange={(e) => set(i, 'amount', e.target.value)} />
          </div>
          <Input aria-label={`Part ${i + 1} category`} list="category-options" value={p.category} onChange={(e) => set(i, 'category', e.target.value)} placeholder="Category" />
          <Input aria-label={`Part ${i + 1} tags`} value={p.tags} onChange={(e) => set(i, 'tags', e.target.value)} placeholder="Extra tags, comma separated (rules add the usual ones)" />
        </div>
      ))}
      <datalist id="category-options">{categories.map((c) => <option key={c} value={c} />)}</datalist>
      <div className="flex items-center justify-between text-sm">
        <Button variant="outline" size="sm" onClick={() => setParts([...parts, { name: txn.name, amount: (Math.max(left, 0) / 100).toFixed(2), category: '', tags: '' }])}>Add part</Button>
        <span className={left === 0 ? 'text-muted-foreground' : 'text-destructive'}>{left === 0 ? 'Adds up' : `${money(Math.abs(left) / 100)} ${left > 0 ? 'left to assign' : 'too much'}`}</span>
      </div>
      {error && <p className="text-destructive text-sm">{error}</p>}
      <div className="flex flex-wrap gap-2">
        <Button onClick={save} disabled={left !== 0}>Save split</Button>
        {existing.length > 0 && <Button variant="outline" onClick={undo}>Undo split</Button>}
        <Button variant="ghost" onClick={onDone}>Cancel</Button>
      </div>
    </div>
  )
}
