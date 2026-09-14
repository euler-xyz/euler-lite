import { afterEach, describe, expect, it, vi } from 'vitest'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })

  return { promise, resolve, reject }
}

describe('useEulerOracleRouters', () => {
  afterEach(() => {
    vi.resetModules()
    vi.doUnmock('~/composables/useEulerSdk')
    vi.doUnmock('~/composables/useV3ChainGate')
  })

  it('does not let a stale chain response overwrite the active chain allowlist', async () => {
    const chainOne = deferred<Array<{ chainId: number, router: string }>>()
    const chainTwo = deferred<Array<{ chainId: number, router: string }>>()

    const fetchOracleRouters = vi.fn((chainId: number) => {
      if (chainId === 1) return chainOne.promise
      if (chainId === 2) return chainTwo.promise
      throw new Error('unexpected chain')
    })
    vi.doMock('~/composables/useEulerSdk', () => ({
      getEulerSdkForChain: async () => ({ oracleAdapterService: { fetchOracleRouters } }),
    }))
    vi.doMock('~/composables/useV3ChainGate', () => ({
      useV3ChainGate: () => ({ isV3EnabledForChain: () => true }),
    }))

    const { useEulerOracleRouters } = await import('~/composables/useEulerOracleRouters')
    const routers = useEulerOracleRouters()

    const firstLoad = routers.loadRecognizedRouters(1)
    const secondLoad = routers.loadRecognizedRouters(2)

    chainTwo.resolve([{ chainId: 2, router: '0xBbB0000000000000000000000000000000000002' }])
    await secondLoad

    expect(routers.recognizedRoutersChainId.value).toBe(2)
    expect(routers.recognizedRouters.value.has('0xbbb0000000000000000000000000000000000002')).toBe(true)

    chainOne.resolve([{ chainId: 1, router: '0xAaA0000000000000000000000000000000000001' }])
    await firstLoad

    expect(routers.recognizedRoutersChainId.value).toBe(2)
    expect(routers.recognizedRouters.value.has('0xbbb0000000000000000000000000000000000002')).toBe(true)
    expect(routers.recognizedRouters.value.has('0xaaa0000000000000000000000000000000000001')).toBe(false)

    await routers.loadRecognizedRouters(1)

    expect(routers.recognizedRoutersChainId.value).toBe(1)
    expect(routers.recognizedRouters.value.has('0xaaa0000000000000000000000000000000000001')).toBe(true)
  })

  it('deduplicates concurrent loads but re-enters the SDK after completion', async () => {
    const firstRequest = deferred<Array<{ chainId: number, router: string }>>()
    const secondRequest = deferred<Array<{ chainId: number, router: string }>>()
    const fetchOracleRouters = vi.fn()
      .mockReturnValueOnce(firstRequest.promise)
      .mockReturnValueOnce(secondRequest.promise)

    vi.doMock('~/composables/useEulerSdk', () => ({
      getEulerSdkForChain: async () => ({ oracleAdapterService: { fetchOracleRouters } }),
    }))
    vi.doMock('~/composables/useV3ChainGate', () => ({
      useV3ChainGate: () => ({ isV3EnabledForChain: () => true }),
    }))

    const { useEulerOracleRouters } = await import('~/composables/useEulerOracleRouters')
    const routers = useEulerOracleRouters()

    const firstLoad = routers.loadRecognizedRouters(1)
    const concurrentLoad = routers.loadRecognizedRouters(1)
    await vi.waitFor(() => expect(fetchOracleRouters).toHaveBeenCalledTimes(1))

    firstRequest.resolve([{ chainId: 1, router: '0xAaA0000000000000000000000000000000000001' }])
    await Promise.all([firstLoad, concurrentLoad])
    expect(routers.recognizedRouters.value.has('0xaaa0000000000000000000000000000000000001')).toBe(true)

    const refreshedLoad = routers.loadRecognizedRouters(1)
    await vi.waitFor(() => expect(fetchOracleRouters).toHaveBeenCalledTimes(2))
    secondRequest.resolve([{ chainId: 1, router: '0xBbB0000000000000000000000000000000000002' }])
    await refreshedLoad

    expect(routers.recognizedRouters.value.has('0xbbb0000000000000000000000000000000000002')).toBe(true)
    expect(routers.recognizedRouters.value.has('0xaaa0000000000000000000000000000000000001')).toBe(false)
  })

  it('ignores router rows that belong to another chain', async () => {
    const fetchOracleRouters = vi.fn().mockResolvedValue([
      { chainId: 1, router: '0xAaA0000000000000000000000000000000000001' },
      { chainId: 10, router: '0xBbB0000000000000000000000000000000000002' },
    ])
    vi.doMock('~/composables/useEulerSdk', () => ({
      getEulerSdkForChain: async () => ({ oracleAdapterService: { fetchOracleRouters } }),
    }))
    vi.doMock('~/composables/useV3ChainGate', () => ({
      useV3ChainGate: () => ({ isV3EnabledForChain: () => true }),
    }))

    const { useEulerOracleRouters } = await import('~/composables/useEulerOracleRouters')
    const routers = useEulerOracleRouters()
    await routers.loadRecognizedRouters(1)

    expect(routers.recognizedRouters.value.has('0xaaa0000000000000000000000000000000000001')).toBe(true)
    expect(routers.recognizedRouters.value.has('0xbbb0000000000000000000000000000000000002')).toBe(false)
  })

  it('resolves concurrent loads to an empty set when the SDK request fails', async () => {
    const request = deferred<Array<{ chainId: number, router: string }>>()
    const fetchOracleRouters = vi.fn().mockReturnValue(request.promise)
    vi.doMock('~/composables/useEulerSdk', () => ({
      getEulerSdkForChain: async () => ({ oracleAdapterService: { fetchOracleRouters } }),
    }))
    vi.doMock('~/composables/useV3ChainGate', () => ({
      useV3ChainGate: () => ({ isV3EnabledForChain: () => true }),
    }))

    const { useEulerOracleRouters } = await import('~/composables/useEulerOracleRouters')
    const routers = useEulerOracleRouters()
    const first = routers.loadRecognizedRouters(1)
    const second = routers.loadRecognizedRouters(1)
    await vi.waitFor(() => expect(fetchOracleRouters).toHaveBeenCalledTimes(1))
    request.reject(new Error('upstream failed'))

    await expect(first).resolves.toEqual(new Set())
    await expect(second).resolves.toEqual(new Set())
  })

  it('does not request recognized routers for a V3-gated chain', async () => {
    const fetchOracleRouters = vi.fn()
    vi.doMock('~/composables/useEulerSdk', () => ({
      getEulerSdkForChain: async () => ({ oracleAdapterService: { fetchOracleRouters } }),
    }))
    vi.doMock('~/composables/useV3ChainGate', () => ({
      useV3ChainGate: () => ({ isV3EnabledForChain: () => false }),
    }))

    const { useEulerOracleRouters } = await import('~/composables/useEulerOracleRouters')
    const routers = useEulerOracleRouters()

    await expect(routers.loadRecognizedRouters(80094)).resolves.toEqual(new Set())
    expect(fetchOracleRouters).not.toHaveBeenCalled()
    expect(routers.recognizedRoutersChainId.value).toBe(80094)
  })
})
