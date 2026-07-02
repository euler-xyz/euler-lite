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
    vi.unstubAllGlobals()
  })

  it('does not let a stale chain response overwrite the active chain allowlist', async () => {
    const chainOne = deferred<string[]>()
    const chainTwo = deferred<string[]>()

    vi.stubGlobal('$fetch', vi.fn((_url: string, options?: { query?: { chainId?: number } }) => {
      if (options?.query?.chainId === 1) return chainOne.promise
      if (options?.query?.chainId === 2) return chainTwo.promise
      throw new Error('unexpected chain')
    }))

    const { useEulerOracleRouters } = await import('~/composables/useEulerOracleRouters')
    const routers = useEulerOracleRouters()

    const firstLoad = routers.loadRecognizedRouters(1)
    const secondLoad = routers.loadRecognizedRouters(2)

    chainTwo.resolve(['0xBbB0000000000000000000000000000000000002'])
    await secondLoad

    expect(routers.recognizedRoutersChainId.value).toBe(2)
    expect(routers.recognizedRouters.value.has('0xbbb0000000000000000000000000000000000002')).toBe(true)

    chainOne.resolve(['0xAaA0000000000000000000000000000000000001'])
    await firstLoad

    expect(routers.recognizedRoutersChainId.value).toBe(2)
    expect(routers.recognizedRouters.value.has('0xbbb0000000000000000000000000000000000002')).toBe(true)
    expect(routers.recognizedRouters.value.has('0xaaa0000000000000000000000000000000000001')).toBe(false)

    await routers.loadRecognizedRouters(1)

    expect(routers.recognizedRoutersChainId.value).toBe(1)
    expect(routers.recognizedRouters.value.has('0xaaa0000000000000000000000000000000000001')).toBe(true)
  })
})
