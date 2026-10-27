import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
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
      '/api/internal/v3/evk/vaults/open-interest/by-collateral?chainId=1',
      '/api/internal/v3/evk/vaults/open-interest/by-collateral?chainId=2',
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

  describe('re-reading once V3 recomputes', () => {
    const VAULT = '0x0000000000000000000000000000000000000001'
    const COLLATERAL = '0x000000000000000000000000000000000000000a'
    const REFRESHED_AT = Date.parse('2026-10-27T16:00:00.000Z')
    const MINUTE = 60_000
    type Reply = { data: Record<string, Record<string, number>>, meta: { refreshedAt: string } }
    const reply = (openInterest: number, refreshedAt: number): Reply => ({
      data: { [VAULT]: { [COLLATERAL]: openInterest } },
      meta: { refreshedAt: new Date(refreshedAt).toISOString() },
    })

    const setup = async (fetchMock: ReturnType<typeof vi.fn>, chainId = ref(1)) => {
      const states = new Map<string, Ref<unknown>>()
      vi.stubGlobal('computed', computed)
      vi.stubGlobal('useEulerAddresses', () => ({ chainId }))
      vi.stubGlobal('useV3ChainGate', () => ({ isV3EnabledForChain: () => true }))
      vi.stubGlobal('useState', <T>(key: string, init: () => T) => {
        if (!states.has(key)) states.set(key, ref(init()))
        return states.get(key) as Ref<T>
      })
      vi.stubGlobal('$fetch', fetchMock)
      const { useCollateralOpenInterest } = await import('~/composables/useCollateralOpenInterest')
      return useCollateralOpenInterest()
    }

    beforeEach(() => {
      vi.useFakeTimers()
      vi.setSystemTime(REFRESHED_AT + MINUTE)
    })

    afterEach(() => {
      vi.useRealTimers()
    })

    it('re-reads the loaded chain once the next recompute is due, without a loading state', async () => {
      const next = deferred<Reply>()
      const fetchMock = vi.fn()
        .mockResolvedValueOnce(reply(1, REFRESHED_AT))
        .mockReturnValueOnce(next.promise)
      const openInterest = await setup(fetchMock)
      await openInterest.load()

      vi.setSystemTime(REFRESHED_AT + 15 * MINUTE - 1)
      await openInterest.refreshIfStale()
      expect(fetchMock).toHaveBeenCalledTimes(1)

      vi.setSystemTime(REFRESHED_AT + 15 * MINUTE)
      const refreshing = openInterest.refreshIfStale()
      expect(fetchMock).toHaveBeenCalledTimes(2)
      expect(openInterest.isLoading.value).toBe(false)
      expect(openInterest.isLoaded.value).toBe(true)

      next.resolve(reply(2, REFRESHED_AT + 15 * MINUTE))
      await refreshing
      expect(openInterest.getOpenInterestForVault(VAULT)).toEqual({ [COLLATERAL]: 2 })
    })

    it('keeps the loaded values when a re-read fails', async () => {
      const fetchMock = vi.fn()
        .mockResolvedValueOnce(reply(1, REFRESHED_AT))
        .mockRejectedValueOnce(new Error('backend down'))
      const openInterest = await setup(fetchMock)
      await openInterest.load()

      vi.setSystemTime(REFRESHED_AT + 16 * MINUTE)
      await openInterest.refreshIfStale()

      expect(fetchMock).toHaveBeenCalledTimes(2)
      expect(openInterest.hasError.value).toBe(false)
      expect(openInterest.isLoaded.value).toBe(true)
      expect(openInterest.getOpenInterestForVault(VAULT)).toEqual({ [COLLATERAL]: 1 })
    })

    it('drops a re-read that finishes after a chain switch', async () => {
      const chainId = ref(1)
      const next = deferred<Reply>()
      const fetchMock = vi.fn()
        .mockResolvedValueOnce(reply(1, REFRESHED_AT))
        .mockReturnValueOnce(next.promise)
        .mockResolvedValueOnce({ data: {}, meta: { refreshedAt: new Date(REFRESHED_AT).toISOString() } })
      const openInterest = await setup(fetchMock, chainId)
      await openInterest.load()

      vi.setSystemTime(REFRESHED_AT + 16 * MINUTE)
      const refreshing = openInterest.refreshIfStale()
      chainId.value = 2
      await openInterest.load()
      next.resolve(reply(2, REFRESHED_AT + 15 * MINUTE))
      await refreshing

      expect(openInterest.getOpenInterestForVault(VAULT)).toEqual({})
    })

    it('does not read a chain nobody loaded', async () => {
      const fetchMock = vi.fn()
      const openInterest = await setup(fetchMock)

      vi.setSystemTime(REFRESHED_AT + 30 * MINUTE)
      await openInterest.refreshIfStale()

      expect(fetchMock).not.toHaveBeenCalled()
    })
  })
})
