import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { computed } from 'vue'

describe('live browser chain policy', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.stubGlobal('window', { __CHAIN_CONFIG__: {
      enabledChainIds: [1, 999], deprecatedChainIds: [], onchainSdkChainIds: [1], eVaultFetchChunkChainIds: [],
    } })
  })
  afterEach(() => vi.unstubAllGlobals())

  it('updates captured reactive arrays, V3 gating and cache revision together', async () => {
    const { useChainConfig, applyChainReadPolicy } = await import('~/composables/useChainConfig')
    vi.stubGlobal('useChainConfig', useChainConfig)
    vi.stubGlobal('useEnvConfig', () => ({ enableV3Backend: true }))
    const { useV3ChainGate } = await import('~/composables/useV3ChainGate')
    const { isV3EnabledForChain } = useV3ChainGate()
    const config = useChainConfig()
    const { deprecatedChainIds, onchainSdkChainIds } = config
    const deprecated = computed(() => new Set(deprecatedChainIds).has(999))
    const enabledV3 = computed(() => isV3EnabledForChain(999))
    expect(deprecated.value).toBe(false)
    expect(enabledV3.value).toBe(true)
    const indexedDeprecated = { deprecated: true, onchain: false, metadataOnly: false }
    expect(applyChainReadPolicy(999, indexedDeprecated)).toBe(true)
    expect(deprecated.value).toBe(true)
    expect(enabledV3.value).toBe(true)
    const policy = { deprecated: true, onchain: true, metadataOnly: true }
    expect(applyChainReadPolicy(999, policy)).toBe(true)
    expect(deprecated.value).toBe(true)
    expect(enabledV3.value).toBe(false)
    expect(config.onchainSdkChainIds).toBe(onchainSdkChainIds)
    expect(onchainSdkChainIds).toEqual([1, 999])
    expect(config.policyRevision).toBe(2)
    expect(applyChainReadPolicy(999, policy)).toBe(false)
    expect(config.policyRevision).toBe(2)

    applyChainReadPolicy(999, indexedDeprecated)
    expect(deprecated.value).toBe(true)
    expect(enabledV3.value).toBe(true)
    expect(onchainSdkChainIds).toEqual([1])
    expect(config.policyRevision).toBe(3)
  })

  it('cannot enable an unconfigured chain through a policy response', async () => {
    const { useChainConfig, applyChainReadPolicy } = await import('~/composables/useChainConfig')
    expect(applyChainReadPolicy(146, { deprecated: true, onchain: true, metadataOnly: true })).toBe(false)
    expect(useChainConfig().policyRevision).toBe(0)
    expect(useChainConfig().enabledChainIds).toEqual([1, 999])
  })

  it('deduplicates independent policy reads and ignores a read superseded locally', async () => {
    const { refreshChainReadPolicy, useChainConfig, applyChainReadPolicy } = await import('~/composables/useChainConfig')
    let resolve!: (value: unknown) => void
    const fetch = vi.fn(() => new Promise((done) => {
      resolve = done
    }))
    vi.stubGlobal('$fetch', fetch)
    const first = refreshChainReadPolicy(999)
    const joined = refreshChainReadPolicy(999)
    expect(fetch).toHaveBeenCalledExactlyOnceWith('/api/internal/chain-policy', expect.objectContaining({ cache: 'no-store', query: { chainId: 999 } }))
    applyChainReadPolicy(999, { deprecated: true, onchain: true, metadataOnly: true })
    resolve({ chainId: 999, policy: { deprecated: false, onchain: false, metadataOnly: false } })
    await Promise.all([first, joined])
    expect(useChainConfig().deprecatedChainIds).toEqual([999])
  })

  it.each([true, false])('retains indexed=%s routing during an outage and applies recovery', async (indexed) => {
    const { refreshChainReadPolicy, useChainConfig, applyChainReadPolicy } = await import('~/composables/useChainConfig')
    applyChainReadPolicy(999, { deprecated: true, onchain: !indexed, metadataOnly: !indexed })
    const revision = useChainConfig().policyRevision
    const fetch = vi.fn().mockRejectedValueOnce(new Error('policy unavailable'))
      .mockResolvedValueOnce({ chainId: 999, policy: { deprecated: true, onchain: indexed, metadataOnly: indexed } })
    vi.stubGlobal('$fetch', fetch)
    await expect(refreshChainReadPolicy(999)).rejects.toThrow('policy unavailable')
    expect(useChainConfig().onchainSdkChainIds).toEqual(indexed ? [1] : [1, 999])
    expect(useChainConfig().metadataOnlyChainIds).toEqual(indexed ? [] : [999])
    expect(useChainConfig().policyRevision).toBe(revision)
    await refreshChainReadPolicy(999)
    expect(useChainConfig().onchainSdkChainIds).toEqual(indexed ? [1, 999] : [1])
    expect(useChainConfig().metadataOnlyChainIds).toEqual(indexed ? [999] : [])
    expect(useChainConfig().deprecatedChainIds).toEqual([999])
    expect(useChainConfig().policyRevision).toBe(revision + 1)
  })
})
