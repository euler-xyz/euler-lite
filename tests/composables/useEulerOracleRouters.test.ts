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
  })

  it('does not let a stale chain response overwrite the active chain allowlist', async () => {
    const chainOne = deferred<Array<{ router: string }>>()
    const chainTwo = deferred<Array<{ router: string }>>()

    const fetchOracleRouters = vi.fn((chainId: number) => {
      if (chainId === 1) return chainOne.promise
      if (chainId === 2) return chainTwo.promise
      throw new Error('unexpected chain')
    })
    vi.doMock('~/composables/useEulerSdk', () => ({
      getEulerSdk: async () => ({ oracleAdapterService: { fetchOracleRouters } }),
    }))

    const { useEulerOracleRouters } = await import('~/composables/useEulerOracleRouters')
    const routers = useEulerOracleRouters()

    const firstLoad = routers.loadIndexedRouters(1)
    const secondLoad = routers.loadIndexedRouters(2)

    chainTwo.resolve([{ router: '0xBbB0000000000000000000000000000000000002' }])
    await secondLoad

    expect(routers.indexedRoutersChainId.value).toBe(2)
    expect(routers.indexedRouters.value.has('0xbbb0000000000000000000000000000000000002')).toBe(true)

    chainOne.resolve([{ router: '0xAaA0000000000000000000000000000000000001' }])
    await firstLoad

    expect(routers.indexedRoutersChainId.value).toBe(2)
    expect(routers.indexedRouters.value.has('0xbbb0000000000000000000000000000000000002')).toBe(true)
    expect(routers.indexedRouters.value.has('0xaaa0000000000000000000000000000000000001')).toBe(false)

    await routers.loadIndexedRouters(1)

    expect(routers.indexedRoutersChainId.value).toBe(1)
    expect(routers.indexedRouters.value.has('0xaaa0000000000000000000000000000000000001')).toBe(true)
  })
})
