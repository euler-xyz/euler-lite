interface CacheEntry<T> {
  data: T
  timestamp: number
}

interface TtlCacheOptions {
  ttlMs: number
  maxEntries?: number
  /**
   * Maximum time past TTL that `getStale()` will still return an entry.
   * After `ttlMs + maxStaleMs`, the entry is treated as gone — consumers
   * must either refetch or surface the failure to the caller.
   *
   * Bounds how far a prolonged upstream outage can push user-visible data
   * age. The former behavior (serve stale forever) meant a week-long
   * upstream outage would keep serving week-old data silently.
   *
   * Default: `2 × ttlMs`, capped at the hard staleness ceiling.
   */
  maxStaleMs?: number
}

/**
 * Hard ceiling on how long any cache entry can be served after its TTL
 * elapses. 30 minutes bounds the worst-case user-visible data age across
 * every cache in the system (uniform policy from the user's perspective).
 */
const STALENESS_CEILING_MS = 30 * 60_000

export function createTtlCache<T>(options: TtlCacheOptions) {
  const { ttlMs, maxEntries = 500 } = options
  const maxStaleMs = Math.min(options.maxStaleMs ?? 2 * ttlMs, STALENESS_CEILING_MS)
  const map = new Map<string, CacheEntry<T>>()

  const evictOldest = () => {
    if (map.size <= maxEntries) return

    let oldestKey: string | null = null
    let oldestTs = Infinity

    for (const [key, entry] of map) {
      if (entry.timestamp < oldestTs) {
        oldestTs = entry.timestamp
        oldestKey = key
      }
    }

    if (oldestKey) {
      map.delete(oldestKey)
    }
  }

  return {
    /** Returns data only if fresh (within TTL). */
    get(key: string): T | undefined {
      const entry = map.get(key)
      if (!entry) return undefined
      if ((Date.now() - entry.timestamp) >= ttlMs) return undefined
      return entry.data
    },

    /**
     * Returns data past TTL but within `ttlMs + maxStaleMs`. Beyond that
     * ceiling, returns undefined — the entry is evicted eagerly so callers
     * can't accidentally serve infinitely-stale data during long outages.
     */
    getStale(key: string): T | undefined {
      const entry = map.get(key)
      if (!entry) return undefined
      const age = Date.now() - entry.timestamp
      if (age > ttlMs + maxStaleMs) {
        map.delete(key)
        return undefined
      }
      return entry.data
    },

    set(key: string, data: T): void {
      map.set(key, { data, timestamp: Date.now() })
      evictOldest()
    },
  }
}
