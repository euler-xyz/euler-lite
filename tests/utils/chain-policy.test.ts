import { describe, expect, it } from 'vitest'
import { getChainReadPolicy, resolveChainPolicy } from '~/utils/chain-policy'
import { readChainRegistry } from '~/utils/chain-status'

const env = {
  enabledChainIds: [1, 999],
  deprecatedChainIds: [],
  onchainSdkChainIds: [],
  eVaultFetchChunkChainIds: [],
}
const registry = (status: string) => readChainRegistry([{ chainId: 1, status: 'production' }, { chainId: 999, status }])

describe('resolved chain read policy', () => {
  it('keeps V3 routing when an indexed chain is deprecated or reactivated', () => {
    const resolve = (status: string) => getChainReadPolicy(resolveChainPolicy(env, registry(status), true, 'v3', { indexedChainIds: [1, 999] }), 999)
    expect(resolve('production')).toEqual({ deprecated: false, onchain: false, metadataOnly: false })
    expect(resolve('deprecated')).toEqual({ deprecated: true, onchain: false, metadataOnly: false })
    expect(resolve('production')).toEqual({ deprecated: false, onchain: false, metadataOnly: false })
    expect(env.onchainSdkChainIds).toEqual([])
    expect(env.deprecatedChainIds).toEqual([])
  })

  it.each(['production', 'deprecated'])('follows V3 retirement and reactivation independently of %s lifecycle', (status) => {
    const resolve = (indexedChainIds: number[]) => getChainReadPolicy(resolveChainPolicy(env, registry(status), true, 'v3', { indexedChainIds }), 999)
    const deprecated = status === 'deprecated'
    expect(resolve([1, 999])).toEqual({ deprecated, onchain: false, metadataOnly: false })
    expect(resolve([1])).toEqual({ deprecated, onchain: true, metadataOnly: true })
    expect(resolve([1, 999])).toEqual({ deprecated, onchain: false, metadataOnly: false })
  })

  it('adds explicit overrides while keeping full hosted labels on indexed onchain chains', () => {
    const config = { ...env, onchainSdkChainIds: [1], deprecatedChainIds: [999] }
    const resolved = resolveChainPolicy(config, registry('production'), true, 'v3', { indexedChainIds: [1, 999] })
    expect(resolved.onchainSdkChainIds).toEqual([1])
    expect(getChainReadPolicy(resolved, 1)).toEqual({ deprecated: false, onchain: true, metadataOnly: false })
    expect(getChainReadPolicy(resolved, 999)).toEqual({ deprecated: true, onchain: false, metadataOnly: false })
  })

  it('retains an onchain override through retirement and reactivation without pinning label mode', () => {
    const config = { ...env, onchainSdkChainIds: [999], deprecatedChainIds: [999] }
    for (const indexed of [true, false, true]) {
      const resolved = resolveChainPolicy(config, registry('production'), true, 'v3', { indexedChainIds: indexed ? [1, 999] : [1] })
      expect(getChainReadPolicy(resolved, 999)).toEqual({ deprecated: true, onchain: true, metadataOnly: !indexed })
    }
  })

  it('keeps static-label backend choices independent of deprecation', () => {
    const resolved = resolveChainPolicy({ ...env, onchainSdkChainIds: [1] }, registry('deprecated'), true, 'static', { indexedChainIds: [1, 999] })
    expect(resolved.deprecatedChainIds).toEqual([999])
    expect(resolved.onchainSdkChainIds).toEqual([1])
    expect(resolved.metadataOnlyChainIds).toEqual([])
  })

  it('routes retired static-label chains onchain without changing their labels source', () => {
    const resolved = resolveChainPolicy(env, registry('production'), true, 'static', { indexedChainIds: [1] })
    expect(getChainReadPolicy(resolved, 999)).toEqual({ deprecated: false, onchain: true, metadataOnly: false })
  })

  it.each(['unlisted', 'staging'])('does not enable a %s chain through overrides in production', (status) => {
    const resolved = resolveChainPolicy({ ...env, deprecatedChainIds: [999], onchainSdkChainIds: [999] }, registry(status), true, 'v3', { indexedChainIds: [1] })
    expect(resolved.enabledChainIds).toEqual([1])
    expect(resolved.deprecatedChainIds).toEqual([])
    expect(resolved.onchainSdkChainIds).toEqual([])
    expect(resolved.metadataOnlyChainIds).toEqual([])
  })

  it('only applies registry defaults to enabled and admitted chains', () => {
    const resolved = resolveChainPolicy(env, readChainRegistry([{ chainId: 1 }, { chainId: 146, status: 'deprecated' }]), false, 'v3', { indexedChainIds: [1] })
    expect(resolved.enabledChainIds).toEqual([1])
    expect(resolved.onchainSdkChainIds).toEqual([])
    expect(resolved.metadataOnlyChainIds).toEqual([])
  })

  it('does not infer V3 retirement from deprecation when catalog support is unknown', () => {
    const resolved = resolveChainPolicy({ ...env, deprecatedChainIds: [999] }, readChainRegistry(undefined), true, 'v3')
    expect(resolved.enabledChainIds).toEqual([1, 999])
    expect(resolved.onchainSdkChainIds).toEqual([])
    expect(resolved.metadataOnlyChainIds).toEqual([])
  })
})
