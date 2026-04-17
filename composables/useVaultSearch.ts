import type { Ref } from 'vue'

const MAX_QUERY_LENGTH = 200

function sanitizeQuery(raw: string): string {
  return raw
    .replace(/<[^>]*>/g, '')
    .replace(/[.*+?^${}()|[\]\\]/g, '')
    .trim()
    .slice(0, MAX_QUERY_LENGTH)
    .toLowerCase()
}

export function useVaultSearch<T>(
  getSearchableFields: (item: T) => (string | undefined)[],
): {
  searchQuery: Ref<string>
  matchesSearch: (item: T) => boolean
  clearSearch: () => void
} {
  const searchQuery = ref('')

  const matchesSearch = (item: T): boolean => {
    const sanitized = sanitizeQuery(searchQuery.value)
    if (!sanitized) return true
    return getSearchableFields(item).some(
      field => field?.toLowerCase().includes(sanitized),
    )
  }

  const clearSearch = () => {
    searchQuery.value = ''
  }

  return { searchQuery, matchesSearch, clearSearch }
}
