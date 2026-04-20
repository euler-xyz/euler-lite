import { logWarn } from './log'

/**
 * Creates an in-flight dedup registry. Concurrent `run()` calls with the
 * same key share one promise; the key is released when the promise
 * settles. Replaces the hand-rolled `Map<K, Promise<T>>` + `.finally()`
 * pattern that was duplicated across every refresh function.
 *
 * Use when wrapping upstream fetches so concurrent callers (warm-cycle
 * racing a user request, or multiple users arriving at once) collapse
 * onto one round-trip.
 *
 * `peek()` returns the current in-flight promise without starting one —
 * used by SWR paths that want to join an existing refresh rather than
 * trigger a new one.
 */
export interface InFlightDedup<K, T> {
  run: (key: K, task: () => Promise<T>) => Promise<T>
  peek: (key: K) => Promise<T> | undefined
}

export function createInFlightDedup<K, T>(): InFlightDedup<K, T> {
  const map = new Map<K, Promise<T>>()
  return {
    run(key, task) {
      const existing = map.get(key)
      if (existing) return existing
      const p = task().finally(() => {
        map.delete(key)
      })
      map.set(key, p)
      return p
    },
    peek(key) {
      return map.get(key)
    },
  }
}

/**
 * Fire-and-forget background refresh. Used by SWR handlers when serving
 * stale: kick the refresh, swallow the rejection (logWarn for
 * observability), return the stale payload synchronously so no user
 * waits on the refresh.
 */
export function scheduleBackgroundRefresh(context: string, refresh: () => Promise<unknown>): void {
  void refresh().catch((err) => {
    logWarn(context, `background refresh failed:`, err instanceof Error ? err.message : err)
  })
}
