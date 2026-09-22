import type { LocationQuery, LocationQueryValue } from 'vue-router'

// A filter's link parameter can be renamed without breaking the links people
// saved: the page reads the new name first and falls back to the old ones,
// and writes only the new name.
export interface UrlQueryLookup {
  fromLegacy: boolean
  value: LocationQueryValue | LocationQueryValue[] | undefined
}

export function resolveUrlQueryValue(
  query: LocationQuery,
  queryKey: string,
  legacyKeys: readonly string[] = [],
): UrlQueryLookup {
  const current = query[queryKey]
  if (current !== undefined) return { fromLegacy: false, value: current }
  for (const key of legacyKeys) {
    const legacy = query[key]
    if (legacy !== undefined) return { fromLegacy: true, value: legacy }
  }
  return { fromLegacy: false, value: undefined }
}
