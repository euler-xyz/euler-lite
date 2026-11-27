import { afterEach, describe, expect, it, vi } from 'vitest'
import { advanceSdkQueryGeneration, clearSdkQueryFailureCacheForTest, clearSdkQueryGenerationsForTest, sdkBuildQuery, sdkFreshBuildQuery, sdkQueryClient, withSdkQueryScope } from '~/utils/sdk-query-cache'
import { queryClient } from '~/utils/query-client'

describe('sdkBuildQuery', () => {
  afterEach(() => {
    sdkQueryClient.clear()
    clearSdkQueryFailureCacheForTest()
    clearSdkQueryGenerationsForTest()
    vi.useRealTimers()
  })

  it('uses a dedicated query client without default retries', () => {
    expect(sdkQueryClient).not.toBe(queryClient)
    expect(sdkQueryClient.getDefaultOptions().queries?.retry).toBe(0)
    expect(queryClient.getDefaultOptions().queries?.retry).toBe(0)
  })

  it('caches equivalent nested bigint arguments with the SDK serializer', async () => {
    const query = vi.fn(async (_arg: { nested: { amount: bigint } }) => 'ok')
    const wrapped = sdkBuildQuery('queryBatchSimulation', query, {})

    await expect(wrapped({ nested: { amount: 1n } })).resolves.toBe('ok')
    await expect(wrapped({ nested: { amount: 1n } })).resolves.toBe('ok')

    expect(query).toHaveBeenCalledTimes(1)
  })

  it('shares one in-flight SDK query for equivalent concurrent arguments', async () => {
    let resolveQuery: (value: string) => void = () => {}
    const pending = new Promise<string>((resolve) => {
      resolveQuery = resolve
    })
    const query = vi.fn(async (_arg: { vault: string }) => pending)
    const wrapped = sdkBuildQuery('queryVaultAccountInfo', query, {})

    const first = wrapped({ vault: '0x0000000000000000000000000000000000000001' })
    const second = wrapped({ vault: '0x0000000000000000000000000000000000000001' })

    expect(query).toHaveBeenCalledTimes(1)
    resolveQuery('ok')
    await expect(Promise.all([first, second])).resolves.toEqual(['ok', 'ok'])
  })

  it('starts a fresh query after advancing past an in-flight generation', async () => {
    let resolveFirst: (value: string) => void = () => {}
    const firstResult = new Promise<string>((resolve) => {
      resolveFirst = resolve
    })
    const query = vi.fn()
      .mockImplementationOnce(async () => firstResult)
      .mockResolvedValueOnce('post-catch-up')
    const wrapped = sdkBuildQuery('queryAccountVaults', query, {})
    const args = { owner: '0x0000000000000000000000000000000000000001' }

    const first = wrapped(args)
    expect(query).toHaveBeenCalledTimes(1)

    advanceSdkQueryGeneration(['queryAccountVaults'])
    const second = wrapped(args)

    expect(query).toHaveBeenCalledTimes(2)
    await expect(second).resolves.toBe('post-catch-up')

    resolveFirst('pre-catch-up')
    await expect(first).resolves.toBe('pre-catch-up')
    await expect(wrapped(args)).resolves.toBe('post-catch-up')
    expect(query).toHaveBeenCalledTimes(2)
  })

  it('uses SDK-provided cache keys when query metadata supplies one', async () => {
    const query = vi.fn(async (_assets: string[]) => 'ok')
    const wrapped = sdkBuildQuery('queryPythUpdateData', query, {}, {
      getCacheKey: args => JSON.stringify([...(args[0] as string[])].sort()),
    })

    await expect(wrapped(['0x02', '0x01'])).resolves.toBe('ok')
    await expect(wrapped(['0x01', '0x02'])).resolves.toBe('ok')

    expect(query).toHaveBeenCalledTimes(1)
  })

  it('isolates old SDK reads from a new policy, including queries started after the change', async () => {
    let finishOld!: (value: string) => void
    const oldFn = vi.fn().mockImplementationOnce(() => new Promise<string>((resolve) => {
      finishOld = resolve
    })).mockResolvedValue('old-late')
    const newFn = vi.fn().mockResolvedValue('new-policy')
    const old = withSdkQueryScope(sdkBuildQuery, 'policy:0')('queryAccountVaults', oldFn, {})
    const current = withSdkQueryScope(sdkBuildQuery, 'policy:1')('queryAccountVaults', newFn, {})
    const pending = old(999)
    await advanceSdkQueryGeneration(['queryAccountVaults'])
    // A retained old SDK can start a new read even after invalidation.
    await expect(old(999)).resolves.toBe('old-late')
    await expect(current(999)).resolves.toBe('new-policy')
    finishOld('old-pending')
    await expect(pending).resolves.toBe('old-pending')
    await expect(current(999)).resolves.toBe('new-policy')
    expect(newFn).toHaveBeenCalledOnce()
  })

  it('shares fresh SDK results within a policy and preserves SDK cache-key opt-outs', async () => {
    const fresh = withSdkQueryScope(sdkFreshBuildQuery, 'policy:1')('queryAccountVaults', vi.fn().mockResolvedValue('fresh'), {})
    const cachedFn = vi.fn().mockResolvedValue('cached')
    const cached = withSdkQueryScope(sdkBuildQuery, 'policy:1')('queryAccountVaults', cachedFn, {})
    await expect(fresh(999)).resolves.toBe('fresh')
    await expect(cached(999)).resolves.toBe('fresh')
    expect(cachedFn).not.toHaveBeenCalled()
    const uncachedFn = vi.fn().mockResolvedValue(18)
    const uncached = withSdkQueryScope(sdkBuildQuery, 'policy:1')('queryTokenDecimals', uncachedFn, {}, { getCacheKey: () => null })
    await uncached()
    await uncached()
    expect(uncachedFn).toHaveBeenCalledTimes(2)
  })

  it('bypasses both success and failure caches when the SDK supplies a null key', async () => {
    const query = vi.fn()
      .mockRejectedValueOnce(new Error('RPC unavailable'))
      .mockResolvedValueOnce(6)
      .mockResolvedValueOnce(8)
    const wrapped = sdkBuildQuery('queryTokenDecimals', query, {}, { getCacheKey: () => null })

    await expect(wrapped()).rejects.toThrow('RPC unavailable')
    await expect(wrapped()).resolves.toBe(6)
    await expect(wrapped()).resolves.toBe(8)
    expect(query).toHaveBeenCalledTimes(3)
  })

  it('throws instead of bypassing the cache for non-serializable arguments', async () => {
    const circular: Record<string, unknown> = {}
    circular.self = circular
    const query = vi.fn(async (_arg: unknown) => 'ok')
    const wrapped = sdkBuildQuery('queryBatchSimulation', query, {})

    await expect(wrapped(circular)).rejects.toThrow(
      'SDK query arguments for queryBatchSimulation are not serializable',
    )
    expect(query).not.toHaveBeenCalled()
  })

  it('briefly caches failed SDK queries to suppress repeated backend calls', async () => {
    vi.useFakeTimers()
    const error = new Error('backend unavailable')
    const query = vi.fn(async (_arg: { vault: string }) => {
      throw error
    })
    const wrapped = sdkBuildQuery('queryVaultAccountInfo', query, {})

    await expect(wrapped({ vault: '0x0000000000000000000000000000000000000001' })).rejects.toThrow(error)
    await expect(wrapped({ vault: '0x0000000000000000000000000000000000000001' })).rejects.toThrow(error)

    expect(query).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(4_000)
    await expect(wrapped({ vault: '0x0000000000000000000000000000000000000001' })).rejects.toThrow(error)

    expect(query).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(1_001)
    await expect(wrapped({ vault: '0x0000000000000000000000000000000000000001' })).rejects.toThrow(error)

    expect(query).toHaveBeenCalledTimes(2)
  })
})
