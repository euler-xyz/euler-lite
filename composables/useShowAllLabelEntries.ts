export const isShowAllLabelEntriesQuery = (value: unknown): boolean => {
  if (Array.isArray(value)) {
    return value.some(isShowAllLabelEntriesQuery)
  }

  if (value === null) return true
  if (typeof value !== 'string') return value === true

  const normalized = value.trim().toLowerCase()
  return normalized === '' || normalized === '1' || normalized === 'true'
}

export const useShowAllLabelEntries = () => {
  const route = useRoute()
  return computed(() => isShowAllLabelEntriesQuery(route.query.showAll))
}
