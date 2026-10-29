// Visual identity for categories: an emoji per category, a color per group (see --group-* in index.css).
export const GROUPS = {
  home: { label: 'Home & bills', color: 'var(--group-home)' },
  food: { label: 'Food', color: 'var(--group-food)' },
  transport: { label: 'Transport', color: 'var(--group-transport)' },
  fun: { label: 'Travel & fun', color: 'var(--group-fun)' },
  shopping: { label: 'Shopping', color: 'var(--group-shopping)' },
  health: { label: 'Health', color: 'var(--group-health)' },
  work: { label: 'Work & admin', color: 'var(--group-work)' },
  other: { label: 'Other', color: 'var(--group-other)' },
} as const
export type Group = keyof typeof GROUPS

const CATEGORIES: Record<string, [string, Group]> = {
  'Rent': ['🔑', 'home'],
  'Utilities': ['💡', 'home'],
  'Insurance': ['☂️', 'home'],
  'Home': ['🏠', 'home'],
  'Moving': ['📦', 'home'],
  'Subscriptions': ['💳', 'home'],
  'Groceries': ['🥑', 'food'],
  'Restaurants': ['🍽️', 'food'],
  'Bars & Nightlife': ['🍸', 'food'],
  'Car': ['🚗', 'transport'],
  'Transportation': ['🚕', 'transport'],
  'Gas': ['⛽', 'transport'],
  'Tolls': ['🛣️', 'transport'],
  'Travel & Vacation': ['🏖️', 'fun'],
  'Entertainment': ['🎟️', 'fun'],
  'Recreation': ['🎳', 'fun'],
  'Sports': ['🚴', 'fun'],
  'Shops': ['🛍️', 'shopping'],
  'Clothing': ['👕', 'shopping'],
  'Gifts': ['🎁', 'shopping'],
  'Personal Care': ['💅', 'shopping'],
  'Healthcare': ['💊', 'health'],
  'Work Expenses': ['💼', 'work'],
  'Taxes': ['🧾', 'work'],
  'General services': ['🛠️', 'work'],
  'Income': ['💰', 'other'],
  'Transfer': ['↔️', 'other'],
  'Other': ['🏷️', 'other'],
  'Uncategorized': ['❔', 'other'],
}

// The user's own categories and changes to the built-in look (Settings → Categories), loaded with the data.
let custom: Record<string, [string, Group]> = {}
export const setCustomCategories = (c: Record<string, [string, Group]>) => { custom = c }
export const BUILT_IN = Object.keys(CATEGORIES)

export function categoryStyle(name: string) {
  const [emoji, g] = custom[name] ?? CATEGORIES[name] ?? ['•', 'other']
  const group: Group = g in GROUPS ? g : 'other'
  return { emoji, group, color: GROUPS[group].color }
}
