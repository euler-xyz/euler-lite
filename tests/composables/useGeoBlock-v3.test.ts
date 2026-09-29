import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { PublicGeoPolicy } from '@eulerxyz/euler-v2-sdk/public-labels'
import { __setEulerLabelsDataForTest } from '~/composables/useEulerLabels'
import { isAssetBlockedByCountry, isAssetRestrictedByCountry, isVaultBlockedByCountry, isVaultRestrictedByCountry, useGeoBlock } from '~/composables/useGeoBlock'

vi.mock('~/composables/useVaultRegistry', () => ({ useVaultRegistry: () => ({ getVault: () => undefined }) }))
const vault = '0x1111111111111111111111111111111111111111'
const asset = { address: '0x2222222222222222222222222222222222222222', name: 'Ondo token', symbol: 'TEST' }
const rule = (overrides: Partial<PublicGeoPolicy> = {}): PublicGeoPolicy => ({ id: 'rule', chainId: null, productId: null, vaultAddress: null, assetAddress: null, policyType: 'block', countries: ['EEA'], countriesResolved: ['NO', 'DE'], reason: null, createdAt: '', ...overrides })
const set = (policies: PublicGeoPolicy[] | undefined, productId = 'current', chainId = 1) => __setEulerLabelsDataForTest({ geoContext: { policies, chainId, productByVault: { [vault]: productId } } })

describe('V3 geo enforcement', () => {
  beforeEach(() => {
    set([])
    useGeoBlock().country.value = 'NO'
  })
  it('uses countriesResolved, including Norway, without expanding aliases in Lite', () => {
    set([rule()])
    expect(isAssetBlockedByCountry(asset)).toBe(true)
    useGeoBlock().country.value = 'FR'
    expect(isAssetBlockedByCountry(asset)).toBe(false)
  })
  it('ORs global, product, vault and asset rules without narrowing overrides', () => {
    for (const specific of [{}, { chainId: 1, productId: 'current' }, { chainId: 1, vaultAddress: vault }, { chainId: 1, assetAddress: asset.address }]) {
      set([rule(specific), rule({ chainId: 1, vaultAddress: vault, countriesResolved: ['US'] })])
      expect(isVaultBlockedByCountry(vault, { asset })).toBe(true)
    }
  })
  it('uses current assignments and excludes other chains and scoped rules from standalone assets', () => {
    set([rule({ chainId: 1, productId: 'old' }), rule({ chainId: 8453, vaultAddress: vault })])
    expect(isVaultBlockedByCountry(vault, { asset })).toBe(false)
    set([rule({ chainId: 1, productId: 'current' })])
    expect(isVaultBlockedByCountry(vault, { asset })).toBe(true)
    expect(isAssetBlockedByCountry(asset)).toBe(false)
    set([rule({ chainId: 1, productId: 'current' })], 'new')
    expect(isVaultBlockedByCountry(vault, { asset })).toBe(false)
  })
  it('distinguishes unavailable from authored empty, preserving exits and sanctions', () => {
    set(undefined)
    expect(useGeoBlock().isPolicyAvailable.value).toBe(false)
    expect(isVaultRestrictedByCountry(vault, { asset, counterpart: asset })).toBe(true)
    expect(isAssetRestrictedByCountry(asset, { counterpart: asset })).toBe(true)
    expect(isVaultBlockedByCountry(vault, { asset })).toBe(false)
    set([])
    expect(useGeoBlock().isPolicyAvailable.value).toBe(true)
    expect(isVaultRestrictedByCountry(vault, { asset })).toBe(false)
    useGeoBlock().country.value = 'KP'
    expect(isVaultBlockedByCountry(vault, { asset })).toBe(true)
    useGeoBlock().country.value = null
    expect(isVaultBlockedByCountry(vault, { asset })).toBe(true)
  })
  it('preserves bounded pattern matching and limits same-asset exemptions to asset restrictions', () => {
    set([rule({ policyType: 'restrict', assetNameRegex: '^ondo' })])
    expect(isAssetRestrictedByCountry(asset)).toBe(true)
    expect(isAssetRestrictedByCountry({ name: 'x'.repeat(129) })).toBe(true)
    expect(isVaultRestrictedByCountry(vault, { asset, counterpart: asset })).toBe(false)
    set([rule({ policyType: 'restrict', chainId: 1, productId: 'current' })])
    expect(isVaultRestrictedByCountry(vault, { asset, counterpart: asset })).toBe(true)
  })
})
