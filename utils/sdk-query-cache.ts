import { useRuntimeConfig } from '#app'
import { QueryClient } from '@tanstack/vue-query'
import { serializeQueryArgs, type BuildQueryFn, type EulerSDKQueryName } from '@eulerxyz/euler-v2-sdk'
import { DEFAULT_STALE_TIME_MS, FORM_STALE_TIMES, STALE_TIMES } from '~/utils/sdk-query-policy'

const DEFAULT_FAILURE_TTL_MS = 5_000

// Match the app QueryClient: SDK queries already wrap RPC/V3 callers that have
// their own retry behavior, so TanStack's default 3 retries amplifies outages.
export const sdkQueryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 0,
    },
  },
})

type SdkQueryRecord = {
  queryName: string
  serializedArgs: string
  args: readonly unknown[]
  status: 'success' | 'error'
  durationMs: number
  stack?: string
  result?: unknown
  error?: unknown
}

type SdkQueryRecorderWindow = Window & {
  __EULER_SDK_QUERY_RECORDER__?: (record: SdkQueryRecord) => Promise<void> | void
}

const failureCache = new Map<string, { error: unknown, expiresAt: number }>()

type SdkQueryInvalidationListener = (queryNames: ReadonlySet<string>) => void
const sdkQueryInvalidationListeners = new Set<SdkQueryInvalidationListener>()

export const subscribeToSdkQueryInvalidations = (
  listener: SdkQueryInvalidationListener,
) => {
  sdkQueryInvalidationListeners.add(listener)
  return () => sdkQueryInvalidationListeners.delete(listener)
}

const buildSdkQuery = (staleTimes: Partial<Record<EulerSDKQueryName, number>>): BuildQueryFn => {
  return ((queryName: string, fn, _target: object, context) => {
    const wrapped = (async (...args: Parameters<typeof fn>) => {
      const serializedArgs = context?.getCacheKey(args) ?? serializeQueryArgs(args)
      if (serializedArgs === null) {
        throw new TypeError(`SDK query arguments for ${queryName} are not serializable`)
      }

      const startedAt = queryTimerNow()
      const stack = captureSdkQueryStack()
      const queryKey = ['sdk', queryName, serializedArgs] as const
      const failureKey = JSON.stringify(queryKey)
      let usedCachedFailure = false
      try {
        const failure = failureCache.get(failureKey)
        if (failure) {
          if (failure.expiresAt > Date.now()) {
            usedCachedFailure = true
            throw failure.error
          }
          failureCache.delete(failureKey)
        }

        const result = await sdkQueryClient.fetchQuery({
          queryKey,
          queryFn: async () => {
            const value = await fn(...args)
            return value === undefined ? null : value
          },
          staleTime: staleTimes[queryName as EulerSDKQueryName] ?? DEFAULT_STALE_TIME_MS,
        })

        failureCache.delete(failureKey)
        const value = result === null ? undefined : result
        recordSdkQueryIfRequested({ queryName, serializedArgs, args, status: 'success', durationMs: queryTimerElapsed(startedAt), stack, result: value })
        return value
      }
      catch (error) {
        if (!usedCachedFailure) {
          failureCache.set(failureKey, {
            error,
            expiresAt: Date.now() + DEFAULT_FAILURE_TTL_MS,
          })
        }
        recordSdkQueryIfRequested({ queryName, serializedArgs, args, status: 'error', durationMs: queryTimerElapsed(startedAt), stack, error })
        throw error
      }
    }) as typeof fn

    return wrapped
  }) as BuildQueryFn
}

const recordSdkQueryIfRequested = (record: SdkQueryRecord) => {
  if (!isSdkQueryRecordingRequested()) return

  const recorder = (window as SdkQueryRecorderWindow).__EULER_SDK_QUERY_RECORDER__
  if (typeof recorder !== 'function') return

  try {
    void Promise.resolve(recorder(record)).catch(() => undefined)
  }
  catch {
    // Recording is diagnostics-only and must never affect the app query path.
  }
}

const isSdkQueryRecordingRequested = () => {
  if (typeof window === 'undefined') return false

  try {
    const value = (useRuntimeConfig().public as Record<string, unknown>).executionRecordSdkQueries
    return value === true || value === 'true' || value === '1'
  }
  catch {
    return false
  }
}

const queryTimerNow = () => (
  typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now()
)

const queryTimerElapsed = (startedAt: number) => Math.round(queryTimerNow() - startedAt)

const captureSdkQueryStack = () => {
  if (!isSdkQueryRecordingRequested()) return undefined
  return new Error().stack
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
  for (const key of failureCache.keys()) {
    const [, queryName] = JSON.parse(key) as [string, string, string]
    if (names.has(queryName)) failureCache.delete(key)
  }
  const invalidation = sdkQueryClient.invalidateQueries({
    predicate: query =>
      query.queryKey[0] === 'sdk'
      && typeof query.queryKey[1] === 'string'
      && names.has(query.queryKey[1]),
  })
  for (const listener of sdkQueryInvalidationListeners) {
    try {
      listener(names)
    }
    catch {
      // Query invalidation is a global transaction side effect. A display
      // subscriber must not be able to interrupt the remaining invalidation.
    }
  }
  return invalidation
}

export const clearSdkQueryFailureCacheForTest = () => {
  failureCache.clear()
}
