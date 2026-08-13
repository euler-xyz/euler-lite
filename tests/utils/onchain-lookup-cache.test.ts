import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createOnchainLookupCache } from '~/utils/onchain-lookup-cache'

describe('createOnchainLookupCache', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('caches probe results within the TTL', async () => {
    const cache = createOnchainLookupCache<string>(1_000)
    const probe = vi.fn(async () => 'value')

    await expect(cache.load('1:0xabc', probe)).resolves.toBe('value')
    await expect(cache.load('1:0xabc', probe)).resolves.toBe('value')
    expect(probe).toHaveBeenCalledTimes(1)
    expect(cache.read('1:0xabc')).toBe('value')
  })

  it('re-probes after the TTL expires', async () => {
    const cache = createOnchainLookupCache<string>(1_000)
    const probe = vi.fn(async () => 'value')

    await cache.load('1:0xabc', probe)
    vi.advanceTimersByTime(1_001)
    await cache.load('1:0xabc', probe)
    expect(probe).toHaveBeenCalledTimes(2)
  })

  it('shares one probe between concurrent loads', async () => {
    const cache = createOnchainLookupCache<string>(1_000)
    let resolveProbe!: (value: string) => void
    const probe = vi.fn(() => new Promise<string>((resolve) => {
      resolveProbe = resolve
    }))

    const first = cache.load('1:0xabc', probe)
    const second = cache.load('1:0xabc', probe)
    resolveProbe('value')
    await expect(first).resolves.toBe('value')
    await expect(second).resolves.toBe('value')
    expect(probe).toHaveBeenCalledTimes(1)
  })

  it('keys entries independently', async () => {
    const cache = createOnchainLookupCache<string>(1_000)

    await cache.load('1:0xabc', async () => 'mainnet')
    await cache.load('8453:0xabc', async () => 'base')
    expect(cache.read('1:0xabc')).toBe('mainnet')
    expect(cache.read('8453:0xabc')).toBe('base')
  })

  it('does not cache probe failures and retries on the next load', async () => {
    const cache = createOnchainLookupCache<string>(1_000)
    const probe = vi.fn()
      .mockRejectedValueOnce(new Error('rpc down'))
      .mockResolvedValueOnce('value')

    await expect(cache.load('1:0xabc', probe)).resolves.toBeUndefined()
    expect(cache.read('1:0xabc')).toBeUndefined()
    await expect(cache.load('1:0xabc', probe)).resolves.toBe('value')
    expect(probe).toHaveBeenCalledTimes(2)
  })

  it('serves the expired entry when a refresh probe fails', async () => {
    const cache = createOnchainLookupCache<string>(1_000)
    const probe = vi.fn()
      .mockResolvedValueOnce('stale-but-real')
      .mockRejectedValueOnce(new Error('rpc down'))

    await cache.load('1:0xabc', probe)
    vi.advanceTimersByTime(1_001)
    await expect(cache.load('1:0xabc', probe)).resolves.toBe('stale-but-real')
  })
})
