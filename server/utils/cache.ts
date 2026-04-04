interface CacheEntry<T> {
  data: T
  timestamp: number
}

interface TtlCacheOptions {
  ttlMs: number
  maxEntries?: number
}

export function createTtlCache<T>(options: TtlCacheOptions) {
  const { ttlMs, maxEntries = 500 } = options
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
      if ((Date.now() - entry.timestamp) >= ttlMs) {
        map.delete(key)
        return undefined
      }
      return entry.data
    },

    /** Returns data regardless of TTL (for stale-fallback). */
    getStale(key: string): T | undefined {
      return map.get(key)?.data
    },

    set(key: string, data: T): void {
      map.set(key, { data, timestamp: Date.now() })
      evictOldest()
    },

    /** Remove all entries whose TTL has expired. */
    deleteExpired(): void {
      const now = Date.now()
      for (const [key, entry] of map) {
        if ((now - entry.timestamp) >= ttlMs) map.delete(key)
      }
    },
  }
}
