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
      v3ApiUrl: '/api/internal/v3',
    }))
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
})
