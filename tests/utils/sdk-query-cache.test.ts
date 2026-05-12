import { afterEach, describe, expect, it, vi } from 'vitest'
import { sdkBuildQuery, sdkQueryClient } from '~/utils/sdk-query-cache'
import { queryClient } from '~/utils/query-client'

describe('sdkBuildQuery', () => {
  afterEach(() => {
    sdkQueryClient.clear()
  })

  it('uses a dedicated query client with default retries', () => {
    expect(sdkQueryClient).not.toBe(queryClient)
    expect(sdkQueryClient.getDefaultOptions().queries?.retry).toBeUndefined()
    expect(queryClient.getDefaultOptions().queries?.retry).toBe(0)
  })

  it('caches equivalent nested bigint arguments with the SDK serializer', async () => {
    const query = vi.fn(async (_arg: { nested: { amount: bigint } }) => 'ok')
    const wrapped = sdkBuildQuery('queryBatchSimulation', query, {})

    await expect(wrapped({ nested: { amount: 1n } })).resolves.toBe('ok')
    await expect(wrapped({ nested: { amount: 1n } })).resolves.toBe('ok')

    expect(query).toHaveBeenCalledTimes(1)
  })

  it('throws instead of bypassing the cache for non-serializable arguments', async () => {
    const circular: Record<string, unknown> = {}
    circular.self = circular
    const query = vi.fn(async () => 'ok')
    const wrapped = sdkBuildQuery('queryBatchSimulation', query, {})

    await expect(wrapped(circular)).rejects.toThrow(
      'SDK query arguments for queryBatchSimulation are not serializable',
    )
    expect(query).not.toHaveBeenCalled()
  })
})
