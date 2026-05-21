import { QueryClient } from '@tanstack/vue-query'
import { serializeQueryArgs, type BuildQueryFn, type EulerSDKQueryName } from '@eulerxyz/euler-v2-sdk'
import { FORM_STALE_TIMES, STALE_TIMES } from '~/utils/sdk-query-policy'

const SECOND = 1_000

// Non-listed queries fall through to this default. Exercised by the cache
// test's "unknown query name" path. Policy table doc lists the data classes.
const DEFAULT_STALE_TIME_MS = 5 * SECOND

export const sdkQueryClient = new QueryClient()

const buildSdkQuery = (staleTimes: Partial<Record<EulerSDKQueryName, number>>): BuildQueryFn => {
  return ((queryName: string, fn, _target: object, context) => {
    const wrapped = (async (...args: Parameters<typeof fn>) => {
      const serializedArgs = context?.getCacheKey(args) ?? serializeQueryArgs(args)
      if (serializedArgs === null) {
        throw new TypeError(`SDK query arguments for ${queryName} are not serializable`)
      }

      const result = await sdkQueryClient.fetchQuery({
        queryKey: ['sdk', queryName, serializedArgs],
        queryFn: async () => {
          const value = await fn(...args)
          return value === undefined ? null : value
        },
        staleTime: staleTimes[queryName as EulerSDKQueryName] ?? DEFAULT_STALE_TIME_MS,
      })

      return result === null ? undefined : result
    }) as typeof fn

    return wrapped
  }) as BuildQueryFn
}

/** Browsing SDK wrapper — used by `getEulerSdk()` for UI surfaces. */
export const sdkBuildQuery = buildSdkQuery(STALE_TIMES)

/**
 * Plan-time/form SDK wrapper — used by `getEulerSdkFresh()` during plan
 * construction. `FORM_STALE_TIMES` already pre-resolves `formStaleTimeMs ??
 * staleTimeMs` per row, so this is a single lookup.
 */
export const sdkFreshBuildQuery = buildSdkQuery(FORM_STALE_TIMES)

export const invalidateSdkQueries = (queryNames: EulerSDKQueryName[]) => {
  const names = new Set<string>(queryNames)
  return sdkQueryClient.invalidateQueries({
    predicate: query =>
      query.queryKey[0] === 'sdk'
      && typeof query.queryKey[1] === 'string'
      && names.has(query.queryKey[1]),
  })
}
