import type { LocationQuery, LocationQueryValue } from 'vue-router'

// A filter's link parameter can be renamed without breaking the links people
// saved: the page reads the new name first and falls back to the old ones,
// and writes only the new name.
export interface UrlQueryLookup {
  /** The value came from a former name. */
  fromLegacy: boolean
  /** A former name is in the query, whether or not it supplied the value; the URL is rewritten without it. */
  legacyPresent: boolean
  value: LocationQueryValue | LocationQueryValue[] | undefined
}

export function resolveUrlQueryValue(
  query: LocationQuery,
  queryKey: string,
  legacyKeys: readonly string[] = [],
): UrlQueryLookup {
  const legacyPresent = legacyKeys.some(key => query[key] !== undefined)
  const current = query[queryKey]
  if (current !== undefined) return { fromLegacy: false, legacyPresent, value: current }
  for (const key of legacyKeys) {
    const legacy = query[key]
    if (legacy !== undefined) return { fromLegacy: true, legacyPresent, value: legacy }
  }
  return { fromLegacy: false, legacyPresent, value: undefined }
}
