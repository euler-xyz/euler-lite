import { getAddress } from 'viem'
import { describe, expect, it } from 'vitest'
import { normalizeLabelsBundle, matchesDeploymentVaultTag, type PublicLabelsBundle, type StaticLabelsBundle } from '~/utils/public-labels'
import { KPK_VAULT, publicLabelsFixture } from '~/tests/fixtures/public-labels-v20260804151305236'
import staticFiles from '~/tests/fixtures/static-labels.json'

const sibling = '0x00000000000000000000000000000000000000C1'
const hostedBundle = (vaultTag?: string, source: 'v3' | 'v3-metadata' = 'v3'): PublicLabelsBundle => ({
  source,
  labelSet: 'public',
  version: 'test',
  publicLabels: structuredClone(publicLabelsFixture),
  vaultTag,
})

describe('deployment vault tag selection', () => {
  it.each([undefined, '', '  '])('preserves unfiltered behavior for %s', (tag) => {
    const data = normalizeLabelsBundle(1, hostedBundle(tag))
    expect(data).not.toHaveProperty('vaultTagAddresses')
    expect(matchesDeploymentVaultTag(data, KPK_VAULT)).toBe(true)
    expect(matchesDeploymentVaultTag(data, sibling)).toBe(true)
  })

  it.each(['v3', 'v3-metadata'] as const)('matches arbitrary tags per vault in %s without changing trust or policy', (source) => {
    const bundle = hostedBundle(' governance limited ', source)
    if (bundle.source === 'static') throw new Error('Expected hosted bundle')
    bundle.publicLabels.vaults[0].tags = ['governance limited']
    bundle.publicLabels.vaults.push({ ...bundle.publicLabels.vaults[0], address: sibling, tags: [] })
    const data = normalizeLabelsBundle(1, bundle)
    expect(matchesDeploymentVaultTag(data, KPK_VAULT.toLowerCase())).toBe(true)
    expect(matchesDeploymentVaultTag(data, sibling)).toBe(false)
    const { vaultTagAddresses: _selection, ...fullLabels } = data
    expect(fullLabels).toEqual(normalizeLabelsBundle(1, { ...bundle, vaultTag: undefined }))
    expect(data.products['kpk-securitize'].vaults).toContain(getAddress(sibling))
  })

  it.each(['evk', 'earn', 'securitize', 'escrow'] as const)('retains tag selection for standalone %s rows', (vaultType) => {
    const bundle = hostedBundle('base')
    if (bundle.source === 'static') throw new Error('Expected hosted bundle')
    bundle.publicLabels.vaults = [{ ...bundle.publicLabels.vaults[0], vaultType, productId: null, tags: ['base'] }]
    expect(matchesDeploymentVaultTag(normalizeLabelsBundle(1, bundle), KPK_VAULT)).toBe(true)
  })

  it('keeps matching chain-scoped, exact and fail-closed for an unknown tag', () => {
    const bundle = hostedBundle('base')
    if (bundle.source === 'static') throw new Error('Expected hosted bundle')
    bundle.publicLabels.vaults.push({ ...bundle.publicLabels.vaults[0], chainId: 8453, tags: ['base'] })
    expect(matchesDeploymentVaultTag(normalizeLabelsBundle(1, bundle), KPK_VAULT)).toBe(false)
    bundle.publicLabels.vaults[0].tags = ['Base']
    expect(matchesDeploymentVaultTag(normalizeLabelsBundle(1, bundle), KPK_VAULT)).toBe(false)
    expect(normalizeLabelsBundle(1, { ...bundle, vaultTag: 'unknown' }).vaultTagAddresses?.size).toBe(0)
  })

  it('does not promote a tagged hidden vault into verified membership or discovery', () => {
    const bundle = hostedBundle('recently added')
    if (bundle.source !== 'v3') throw new Error('Expected assessed bundle')
    bundle.publicLabels.visibility[KPK_VAULT.toLowerCase()] = {
      status: 'hidden', explorableLend: false, explorableBorrow: false, decidedBy: 'platform', reason: null,
    }
    const data = normalizeLabelsBundle(1, bundle)
    expect(matchesDeploymentVaultTag(data, KPK_VAULT)).toBe(true)
    expect(data.verifiedVaultAddresses).not.toContain(getAddress(KPK_VAULT))
    expect(data.products['kpk-securitize'].vaultOverrides?.[getAddress(KPK_VAULT)]?.notExplorableLend).toBe(true)
  })

  it('honours static product inheritance, overrides and Earn tags while retaining untagged labels', () => {
    const files = structuredClone(staticFiles)
    const vault = files.products.fork.vaults[0]
    files.products.fork.vaults.push(sibling)
    Object.assign(files.products.fork, { tags: ['governance limited'] })
    Object.assign(files.products.fork.vaultOverrides[vault], { tags: ['base'] })
    Object.assign(files.earnVaults[0], { tags: ['base'] })
    const bundle: PublicLabelsBundle = { source: 'static', version: 'test', files: files as unknown as StaticLabelsBundle['files'], logoBaseUrl: 'https://fork.test', fetchedAt: 1, vaultTag: 'base' }
    const data = normalizeLabelsBundle(1, bundle)
    expect(matchesDeploymentVaultTag(data, vault)).toBe(true)
    expect(matchesDeploymentVaultTag(data, files.earnVaults[0].address)).toBe(true)
    expect(matchesDeploymentVaultTag(data, sibling)).toBe(false)
    expect(data.verifiedVaultAddresses).toContain(getAddress(sibling))
    const inherited = normalizeLabelsBundle(1, { ...bundle, vaultTag: 'governance limited' })
    expect(matchesDeploymentVaultTag(inherited, sibling)).toBe(true)
    expect(matchesDeploymentVaultTag(inherited, vault)).toBe(true)
    expect(matchesDeploymentVaultTag(inherited, files.earnVaults[0].address)).toBe(false)
  })
})
