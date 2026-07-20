import { afterEach, describe, expect, it, vi } from 'vitest'
import type { EVault } from '@eulerxyz/euler-v2-sdk'
import {
  activeLayerVaultsRef,
  getLayeredVault,
  mergeLayeredVaults,
  useLayeredVaults,
} from '~/composables/useLayeredVaults'

const ADDRESS = '0x0000000000000000000000000000000000000001'
const fallback = { address: ADDRESS, totalCash: 1_000n } as unknown as EVault
const simulated = { address: ADDRESS, totalCash: 900n } as unknown as EVault

describe('useLayeredVaults', () => {
  afterEach(() => {
    activeLayerVaultsRef.value = {}
    vi.unstubAllGlobals()
  })

  it('prefers the active simulated vault over a registry fallback', () => {
    activeLayerVaultsRef.value = mergeLayeredVaults({}, [simulated])

    expect(getLayeredVault(ADDRESS, fallback)).toBe(simulated)
  })

  it('uses the registry when neither simulated nor caller state is enriched', async () => {
    const getOrFetch = vi.fn(async () => fallback)
    vi.stubGlobal('useVaultRegistry', () => ({ getOrFetch }))

    await expect(useLayeredVaults().resolveLayeredVault(ADDRESS)).resolves.toBe(fallback)
    expect(getOrFetch).toHaveBeenCalledWith(ADDRESS)
  })
})
