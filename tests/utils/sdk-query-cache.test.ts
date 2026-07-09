import { afterEach, describe, expect, it, vi } from 'vitest'
import { clearSdkQueryFailureCacheForTest, sdkBuildQuery, sdkQueryClient } from '~/utils/sdk-query-cache'
import { queryClient } from '~/utils/query-client'

describe('sdkBuildQuery', () => {
  afterEach(() => {
    sdkQueryClient.clear()
    clearSdkQueryFailureCacheForTest()
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

  it('uses SDK-provided cache keys when query metadata supplies one', async () => {
    const query = vi.fn(async (_assets: string[]) => 'ok')
    const wrapped = sdkBuildQuery('queryPythUpdateData', query, {}, {
      getCacheKey: args => JSON.stringify([...(args[0] as string[])].sort()),
    })

    await expect(wrapped(['0x02', '0x01'])).resolves.toBe('ok')
    await expect(wrapped(['0x01', '0x02'])).resolves.toBe('ok')

    expect(query).toHaveBeenCalledTimes(1)
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
