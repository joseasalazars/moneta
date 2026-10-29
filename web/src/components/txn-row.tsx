import { CategoryBadge, TagBadge } from '@/components/badges'
import { Badge } from '@/components/ui/badge'
import { type Txn, money, shortDate } from '@/lib/api'
import { categoryStyle } from '@/lib/categories'
import { useData } from '@/lib/data'

// Compact clickable transaction line, shared by dashboard, accounts, recurrings and review.
// compact hides tags and shows only the category emoji, for narrow cards.
export function TxnRow({ t, showAccount = true, compact = false }: { t: Txn; showAccount?: boolean; compact?: boolean }) {
  const { setEditing } = useData()
  return (
    <button
      type="button"
      onClick={() => setEditing(t)}
      className={`hover:bg-muted/60 -mx-2 flex w-[calc(100%+1rem)] min-w-0 items-center justify-between gap-3 rounded-md px-2 py-1.5 text-left text-sm ${t.excluded ? 'opacity-60' : ''}`}
    >
      <div className="min-w-0 flex-1">
        <div className="truncate font-medium">{t.name}</div>
        <div className="text-muted-foreground truncate text-xs">
          {shortDate(t.date)}{showAccount && ` · ${t.account}`}{t.via && ` · via ${t.via}`}{t.foreign && ` · ${t.foreign}`}{t.note && ` · ${t.note}`}
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-1.5">
        {t.pending && <Badge variant="outline">Pending</Badge>}
        {/* On a phone the badges would push the name and amount off screen: show the category emoji only. */}
        {!compact && <span className="hidden items-center gap-1.5 md:flex">{t.tags.map((tag) => <TagBadge key={tag} name={tag} />)}<CategoryBadge name={t.category} /></span>}
        <span className={compact ? '' : 'md:hidden'} title={t.category} aria-label={t.category}>{categoryStyle(t.category).emoji}</span>
        <span className={`w-24 text-right tabular-nums ${t.amount < 0 ? 'text-[color:var(--status-good)]' : ''}`}>
          {money(-t.amount)}
        </span>
      </div>
    </button>
  )
}
