import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createTtlCache } from '~/server/utils/cache'

const MINUTE = 60_000
const DAY = 24 * 60 * MINUTE

describe('createTtlCache staleness policy', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('serves stale within the default 2×TTL window and evicts beyond it', () => {
    const cache = createTtlCache<string>({ ttlMs: MINUTE })
    cache.set('k', 'v')

    vi.advanceTimersByTime(MINUTE + 1)
    expect(cache.get('k')).toBeUndefined()
    expect(cache.getStale('k')).toBe('v')

    vi.advanceTimersByTime(2 * MINUTE)
    expect(cache.getStale('k')).toBeUndefined()
  })

  it('caps the default stale window at the 30-minute ceiling', () => {
    // 2×TTL would be 40 min; the default window must clamp to 30 min.
    const cache = createTtlCache<string>({ ttlMs: 20 * MINUTE })
    cache.set('k', 'v')

    vi.advanceTimersByTime(49 * MINUTE)
    expect(cache.getStale('k')).toBe('v')

    vi.advanceTimersByTime(2 * MINUTE)
    expect(cache.getStale('k')).toBeUndefined()
  })

  it('honors an explicit maxStaleMs above the default ceiling', () => {
    const cache = createTtlCache<string>({ ttlMs: 5 * MINUTE, maxStaleMs: 7 * DAY })
    cache.set('k', 'v')

    vi.advanceTimersByTime(3 * DAY)
    expect(cache.get('k')).toBeUndefined()
    expect(cache.getStale('k')).toBe('v')

    vi.advanceTimersByTime(5 * DAY)
    expect(cache.getStale('k')).toBeUndefined()
  })

  it('still honors an explicit maxStaleMs below the default', () => {
    const cache = createTtlCache<string>({ ttlMs: 5 * MINUTE, maxStaleMs: MINUTE })
    cache.set('k', 'v')

    vi.advanceTimersByTime(5 * MINUTE + 30_000)
    expect(cache.getStale('k')).toBe('v')

    vi.advanceTimersByTime(MINUTE)
    expect(cache.getStale('k')).toBeUndefined()
  })
})
