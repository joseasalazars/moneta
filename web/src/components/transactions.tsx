import { useMemo, useState } from 'react'
import { CategoryBadge, TagBadge } from '@/components/badges'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { isIncome, isSpend, money, shortDate } from '@/lib/api'
import { useData } from '@/lib/data'

const LIMIT = 500
const ANY = '__any'

export function Transactions({ month }: { month: string | null }) {
  const { ledger, tags, categories, setEditing } = useData()
  const [query, setQuery] = useState('')
  const [tag, setTag] = useState(ANY)
  const [category, setCategory] = useState(ANY)

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    return (ledger?.rows ?? []).filter((t) => !t.pairedWith &&
      (!month || t.date.startsWith(month)) &&
      (tag === ANY || t.tags.includes(tag)) &&
      (category === ANY || t.category === category) &&
      (!q || [t.name, t.category, t.account, t.via ?? '', t.note ?? '', ...t.tags].some((s) => s.toLowerCase().includes(q))))
  }, [ledger, month, query, tag, category])
  const spent = filtered.filter(isSpend).reduce((s, t) => s + t.amount, 0)
  const income = -filtered.filter(isIncome).reduce((s, t) => s + t.amount, 0)

  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <Input className="max-w-xs" placeholder="Search name, category, note, tag…" value={query} onChange={(e) => setQuery(e.target.value)} />
        <Select value={category} onValueChange={setCategory}>
          <SelectTrigger className="w-44"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value={ANY}>All categories</SelectItem>
            {[...categories].sort().map((c) => <SelectItem key={c} value={c}>{c}</SelectItem>)}
          </SelectContent>
        </Select>
        <Select value={tag} onValueChange={setTag}>
          <SelectTrigger className="w-40"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value={ANY}>All tags</SelectItem>
            {tags.map((t) => <SelectItem key={t} value={t}>{t}</SelectItem>)}
          </SelectContent>
        </Select>
        <Button variant="outline" onClick={() => setEditing('new')}>Add transaction</Button>
        <span className="text-muted-foreground text-sm">
          {filtered.length} transactions · {money(spent)} spent{income > 0 && ` · ${money(income)} income`}
        </span>
      </div>
      <Card className="py-0">
        <CardContent className="px-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="pl-4">Date</TableHead>
                <TableHead>Name</TableHead>
                <TableHead>Category</TableHead>
                <TableHead className="hidden md:table-cell">Account</TableHead>
                <TableHead className="pr-4 text-right">Amount</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filtered.slice(0, LIMIT).map((t) => (
                <TableRow key={t.id} onClick={() => setEditing(t)} className={`cursor-pointer ${t.excluded ? 'opacity-60' : ''}`}>
                  <TableCell className="text-muted-foreground pl-4 whitespace-nowrap">{shortDate(t.date)}</TableCell>
                  <TableCell className="max-w-72">
                    <div className="truncate font-medium">{t.name}</div>
                    {t.note && <div className="text-muted-foreground truncate text-xs">{t.note}</div>}
                  </TableCell>
                  <TableCell>
                    <div className="flex flex-wrap gap-1">
                      <CategoryBadge name={t.category} />
                      {t.tags.map((x) => <TagBadge key={x} name={x} />)}
                      {t.pending && <Badge variant="outline">Pending</Badge>}
                      {!t.reviewed && <Badge>New</Badge>}
                    </div>
                  </TableCell>
                  <TableCell className="text-muted-foreground hidden max-w-56 truncate md:table-cell">{t.account}{t.via && ` · via ${t.via}`}</TableCell>
                  <TableCell className={`pr-4 text-right tabular-nums ${t.amount < 0 ? 'text-[color:var(--status-good)]' : ''}`}>
                    {money(-t.amount)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          {filtered.length > LIMIT && (
            <p className="text-muted-foreground p-4 text-center text-sm">Showing {LIMIT} of {filtered.length}. Narrow the search or pick a month.</p>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
