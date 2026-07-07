import { beforeEach, describe, expect, it, vi } from 'vitest'
import { computed, ref, shallowRef } from 'vue'

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
      v3ApiUrl: '/api/v3',
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
      v3ApiUrl: '/api/v3',
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
})
