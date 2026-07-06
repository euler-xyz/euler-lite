import { beforeEach, describe, expect, it, vi } from 'vitest'
import { computed, ref, type Ref } from 'vue'

type Deferred<T> = {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (error?: unknown) => void
}

const deferred = <T>(): Deferred<T> => {
  let resolve!: Deferred<T>['resolve']
  let reject!: Deferred<T>['reject']
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })

  return { promise, resolve, reject }
}

describe('useCollateralOpenInterest', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.unstubAllGlobals()
  })

  it('does not request open interest when v3 is disabled for the chain', async () => {
    const chainId = ref(1)
    const states = new Map<string, Ref<unknown>>()
    const fetchMock = vi.fn()

    vi.stubGlobal('computed', computed)
    vi.stubGlobal('useEulerAddresses', () => ({ chainId }))
    vi.stubGlobal('useV3ChainGate', () => ({ isV3EnabledForChain: () => false }))
    vi.stubGlobal('useState', <T>(key: string, init: () => T) => {
      if (!states.has(key)) states.set(key, ref(init()))
      return states.get(key) as Ref<T>
    })
    vi.stubGlobal('$fetch', fetchMock)

    const { useCollateralOpenInterest } = await import('~/composables/useCollateralOpenInterest')
    const openInterest = useCollateralOpenInterest()

    await openInterest.load()

    expect(fetchMock).not.toHaveBeenCalled()
    expect(openInterest.isOpenInterestEnabled.value).toBe(false)
    expect(openInterest.isLoading.value).toBe(false)
    expect(openInterest.hasError.value).toBe(false)
    expect(openInterest.isLoaded.value).toBe(false)
  })

  it('marks enabled fetch failures as errors', async () => {
    const chainId = ref(1)
    const states = new Map<string, Ref<unknown>>()

    vi.stubGlobal('computed', computed)
    vi.stubGlobal('useEulerAddresses', () => ({ chainId }))
    vi.stubGlobal('useV3ChainGate', () => ({ isV3EnabledForChain: () => true }))
    vi.stubGlobal('useState', <T>(key: string, init: () => T) => {
      if (!states.has(key)) states.set(key, ref(init()))
      return states.get(key) as Ref<T>
    })
    vi.stubGlobal('$fetch', vi.fn(() => Promise.reject(new Error('backend down'))))

    const { useCollateralOpenInterest } = await import('~/composables/useCollateralOpenInterest')
    const openInterest = useCollateralOpenInterest()

    await openInterest.load()

    expect(openInterest.isLoading.value).toBe(false)
    expect(openInterest.hasError.value).toBe(true)
    expect(openInterest.isLoaded.value).toBe(false)
    expect(openInterest.data.value).toEqual({})
  })

  it('ignores stale overlapping chain loads', async () => {
    const chainId = ref(1)
    const states = new Map<string, Ref<unknown>>()
    const requests: Array<{
      url: string
      deferred: Deferred<{ data: Record<string, Record<string, number>> }>
    }> = []

    vi.stubGlobal('computed', computed)
    vi.stubGlobal('useEulerAddresses', () => ({ chainId }))
    vi.stubGlobal('useV3ChainGate', () => ({ isV3EnabledForChain: () => true }))
    vi.stubGlobal('useState', <T>(key: string, init: () => T) => {
      if (!states.has(key)) states.set(key, ref(init()))
      return states.get(key) as Ref<T>
    })
    vi.stubGlobal('$fetch', vi.fn((url: string) => {
      const request = {
        url,
        deferred: deferred<{ data: Record<string, Record<string, number>> }>(),
      }
      requests.push(request)
      return request.deferred.promise
    }))

    const { useCollateralOpenInterest } = await import('~/composables/useCollateralOpenInterest')
    const openInterest = useCollateralOpenInterest()

    const chainOneLoad = openInterest.load()
    chainId.value = 2
    const chainTwoLoad = openInterest.load()

    expect(requests.map(request => request.url)).toEqual([
      '/api/v3/evk/vaults/open-interest/by-collateral?chainId=1',
      '/api/v3/evk/vaults/open-interest/by-collateral?chainId=2',
    ])

    requests[0].deferred.resolve({
      data: {
        '0x0000000000000000000000000000000000000001': {
          '0x000000000000000000000000000000000000000a': 1,
        },
      },
    })
    await chainOneLoad

    expect(openInterest.isLoading.value).toBe(true)
    expect(openInterest.isLoaded.value).toBe(false)
    expect(openInterest.data.value).toEqual({})

    requests[1].deferred.resolve({
      data: {
        '0x0000000000000000000000000000000000000002': {
          '0x000000000000000000000000000000000000000b': 2,
        },
      },
    })
    await chainTwoLoad

    expect(openInterest.isLoading.value).toBe(false)
    expect(openInterest.isLoaded.value).toBe(true)
    expect(openInterest.getOpenInterestForVault('0x0000000000000000000000000000000000000001')).toEqual({})
    expect(openInterest.getOpenInterestForVault('0x0000000000000000000000000000000000000002')).toEqual({
      '0x000000000000000000000000000000000000000b': 2,
    })
  })
})
