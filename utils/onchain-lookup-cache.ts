import { ref } from 'vue'
import { createInFlightDedup } from '~/utils/in-flight'

export type OnchainLookupCache<T> = {
  /**
   * Read the cached value for a key. Reactive — computeds calling this
   * re-evaluate when any lookup completes. `undefined` means "not resolved
   * yet"; a cached `null` (if T includes it) is a resolved negative.
   */
  read: (key: string) => T | undefined
  /**
   * Resolve a key via `probe`, caching the result for `ttlMs`. Concurrent
   * calls for the same key share one probe. A throwing probe (e.g. RPC
   * transport failure) is NOT cached, so a later call retries instead of
   * pinning a transient failure for the TTL.
   */
  load: (key: string, probe: () => Promise<T>) => Promise<T | undefined>
}

/**
 * Module-scoped cache for small on-chain lookups keyed by `${chainId}:${address}`.
 * Keys embed the chain, so chain switches need no invalidation — results land
 * under their own key and stale probes can never overwrite fresher chains.
 */
export const createOnchainLookupCache = <T>(ttlMs: number): OnchainLookupCache<T> => {
  const entries = new Map<string, { value: T, fetchedAt: number }>()
  const inFlight = createInFlightDedup<string, T | undefined>()
  // Bumped after every completed probe so reactive readers re-evaluate.
  const version = ref(0)

  const read = (key: string): T | undefined => {
    void version.value
    return entries.get(key)?.value
  }

  const load = (key: string, probe: () => Promise<T>): Promise<T | undefined> => {
    const cached = entries.get(key)
    if (cached && Date.now() - cached.fetchedAt < ttlMs) {
      return Promise.resolve(cached.value)
    }

    return inFlight.run(key, async () => {
      try {
        const value = await probe()
        entries.set(key, { value, fetchedAt: Date.now() })
        version.value++
        return value
      }
      catch {
        // Serve the expired entry (if any) rather than dropping the badge on
        // a transient RPC failure; the next load() retries the probe.
        return entries.get(key)?.value
      }
    })
  }

  return { read, load }
}
