import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { computed, ref, shallowRef } from 'vue'

const deferred = <T>() => {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

describe('useVaultBadDebt', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.unstubAllGlobals()
  })

  it('does not request bad debt when v3 is disabled', async () => {
    const chainId = ref(1)
    const fetchMock = vi.fn()

    vi.stubGlobal('computed', computed)
    vi.stubGlobal('shallowRef', shallowRef)
    vi.stubGlobal('useEulerAddresses', () => ({ chainId }))
    vi.stubGlobal('useEnvConfig', () => ({
      enableV3Backend: false,
      v3ApiUrl: '/api/internal/v3',
    }))
    vi.stubGlobal('useV3ChainGate', () => ({ isV3EnabledForChain: () => false }))
    vi.stubGlobal('fetch', fetchMock)

    const { useVaultBadDebt } = await import('~/composables/useVaultBadDebt')
    const badDebt = useVaultBadDebt()

    await badDebt.loadBadDebtForChain()

    expect(fetchMock).not.toHaveBeenCalled()
    expect(badDebt.isBadDebtEnabled.value).toBe(false)
    expect(badDebt.isBadDebtLoading.value).toBe(false)
    expect(badDebt.isBadDebtLoaded.value).toBe(false)
    expect(badDebt.badDebtError.value).toBeUndefined()
  })

  it('does not request bad debt for a chain pinned to onchain reads', async () => {
    const chainId = ref(1)
    const fetchMock = vi.fn()
    const onchainChainId = 143

    vi.stubGlobal('computed', computed)
    vi.stubGlobal('shallowRef', shallowRef)
    vi.stubGlobal('useEulerAddresses', () => ({ chainId }))
    vi.stubGlobal('useEnvConfig', () => ({
      enableV3Backend: true,
      v3ApiUrl: '/api/internal/v3',
    }))
    vi.stubGlobal('useV3ChainGate', () => ({
      isV3EnabledForChain: (id: number) => id !== onchainChainId,
    }))
    vi.stubGlobal('fetch', fetchMock)

    const { useVaultBadDebt } = await import('~/composables/useVaultBadDebt')
    const badDebt = useVaultBadDebt()

    await badDebt.loadBadDebtForChain(onchainChainId)

    expect(fetchMock).not.toHaveBeenCalled()
    expect(badDebt.isBadDebtEnabled.value).toBe(true)
    expect(badDebt.badDebtByChain.value.has(onchainChainId)).toBe(false)
  })

  describe('re-reading once V3 recomputes', () => {
    const VAULT = '0x1111111111111111111111111111111111111111'
    const REFRESHED_AT = Date.parse('2026-10-27T16:00:00.000Z')
    const MINUTE = 60_000

    const row = (badDebtUsd: number) => ({
      chainId: 1,
      borrowVault: VAULT,
      borrowAsset: '0x2222222222222222222222222222222222222222',
      accountCount: 1,
      debtUsd: 100,
      collateralUsd: 0,
      coveredDebtUsd: 0,
      badDebtUsd,
      calculationTimestamp: '2026-10-27T16:00:00.000Z',
      priceTimestamp: null,
      refreshedAt: '2026-10-27T16:00:00.000Z',
    })
    const reply = (badDebtUsd: number, refreshedAt: number) => ({
      ok: true,
      json: async () => ({ data: [row(badDebtUsd)], meta: { refreshedAt: new Date(refreshedAt).toISOString() } }),
    })

    const setup = async (fetchMock: ReturnType<typeof vi.fn>) => {
      vi.stubGlobal('computed', computed)
      vi.stubGlobal('shallowRef', shallowRef)
      vi.stubGlobal('useEulerAddresses', () => ({ chainId: ref(1) }))
      vi.stubGlobal('useEnvConfig', () => ({ enableV3Backend: true, v3ApiUrl: '/api/internal/v3' }))
      vi.stubGlobal('useV3ChainGate', () => ({ isV3EnabledForChain: () => true }))
      vi.stubGlobal('fetch', fetchMock)
      const { useVaultBadDebt } = await import('~/composables/useVaultBadDebt')
      return useVaultBadDebt()
    }

    beforeEach(() => {
      vi.useFakeTimers()
      vi.setSystemTime(REFRESHED_AT + MINUTE)
    })

    afterEach(() => {
      vi.useRealTimers()
    })

    it('re-reads a loaded chain once the next recompute is due, without a loading state', async () => {
      const next = deferred<ReturnType<typeof reply>>()
      const fetchMock = vi.fn()
        .mockResolvedValueOnce(reply(10, REFRESHED_AT))
        .mockReturnValueOnce(next.promise)
      const badDebt = await setup(fetchMock)
      await badDebt.loadBadDebtForChain()

      vi.setSystemTime(REFRESHED_AT + 15 * MINUTE - 1)
      await badDebt.refreshBadDebtIfStale()
      expect(fetchMock).toHaveBeenCalledTimes(1)

      vi.setSystemTime(REFRESHED_AT + 15 * MINUTE)
      const refreshing = badDebt.refreshBadDebtIfStale()
      expect(fetchMock).toHaveBeenCalledTimes(2)
      expect(badDebt.isBadDebtLoading.value).toBe(false)
      expect(badDebt.getVaultBadDebt(VAULT)?.badDebtUsd).toBe(10)

      next.resolve(reply(20, REFRESHED_AT + 15 * MINUTE))
      await refreshing
      expect(badDebt.getVaultBadDebt(VAULT)?.badDebtUsd).toBe(20)
      expect(badDebt.isBadDebtLoaded.value).toBe(true)
    })

    it('keeps the loaded values when a re-read fails', async () => {
      const fetchMock = vi.fn()
        .mockResolvedValueOnce(reply(10, REFRESHED_AT))
        .mockRejectedValueOnce(new Error('upstream unavailable'))
      const badDebt = await setup(fetchMock)
      await badDebt.loadBadDebtForChain()

      vi.setSystemTime(REFRESHED_AT + 16 * MINUTE)
      await badDebt.refreshBadDebtIfStale()

      expect(fetchMock).toHaveBeenCalledTimes(2)
      expect(badDebt.getVaultBadDebt(VAULT)?.badDebtUsd).toBe(10)
      expect(badDebt.badDebtError.value).toBeUndefined()
      expect(badDebt.isBadDebtLoaded.value).toBe(true)
    })

    it('does not read a chain nobody loaded', async () => {
      const fetchMock = vi.fn()
      const badDebt = await setup(fetchMock)

      vi.setSystemTime(REFRESHED_AT + 30 * MINUTE)
      await badDebt.refreshBadDebtIfStale()

      expect(fetchMock).not.toHaveBeenCalled()
    })
  })
})
