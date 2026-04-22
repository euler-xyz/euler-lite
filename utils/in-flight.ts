/**
 * Creates an in-flight dedup registry. Concurrent `run()` calls with the
 * same key share one promise; the key is released when the promise
 * settles.
 *
 * Environment-agnostic — used on both the server (wrapping upstream
 * fetches so concurrent warm-cycle + user requests collapse onto one
 * round-trip) and the client (wrapping `$fetch` so the chain-switch
 * watcher + poll interval share one HTTP call).
 *
 * `peek()` returns the current in-flight promise without starting one —
 * for callers that want to observe an existing refresh rather than
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
