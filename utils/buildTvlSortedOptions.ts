import type { SelectOption } from '~/components/ui/modals/select.types'

export interface FilterOptionEntry {
  key: string
  tvl: number
  label: string
  icon?: string
  iconFallback?: string
}

export function buildTvlSortedOptions(entries: FilterOptionEntry[]): SelectOption[] {
  const tvlByKey = new Map<string, number>()
  const seen = new Set<string>()
  const options: SelectOption[] = []

  for (const entry of entries) {
    tvlByKey.set(entry.key, (tvlByKey.get(entry.key) ?? 0) + entry.tvl)
    if (!seen.has(entry.key)) {
      seen.add(entry.key)
      options.push({ label: entry.label, value: entry.key, icon: entry.icon, iconFallback: entry.iconFallback })
    }
  }

  return options.sort((a, b) => (tvlByKey.get(b.value) ?? 0) - (tvlByKey.get(a.value) ?? 0))
}
