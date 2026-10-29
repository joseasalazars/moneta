import { HashIcon } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { categoryStyle } from '@/lib/categories'

// Color sits on the dot, text stays in normal ink; the emoji + name carry identity without relying on color.
export function CategoryBadge({ name }: { name: string }) {
  const { emoji, color } = categoryStyle(name)
  return (
    <Badge variant="outline" className="gap-1.5">
      <span className="size-2 rounded-full" style={{ background: color }} aria-hidden />
      <span aria-hidden>{emoji}</span>
      {name}
    </Badge>
  )
}

export function TagBadge({ name }: { name: string }) {
  return (
    <Badge variant="secondary" className="text-muted-foreground gap-0.5">
      <HashIcon className="size-3" aria-hidden />
      {name}
    </Badge>
  )
}

// Thin horizontal bar with a rounded data end, used for category and tag shares.
export function Bar({ value, color }: { value: number; color: string }) {
  return (
    <div className="bg-muted h-1.5 w-full overflow-hidden rounded-full">
      <div className="h-full rounded-full" style={{ width: `${Math.max(0, Math.min(100, value))}%`, background: color }} />
    </div>
  )
}
