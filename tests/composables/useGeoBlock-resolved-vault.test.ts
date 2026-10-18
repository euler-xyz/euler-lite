import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ref } from 'vue'
import type { PublicGeoPolicy } from '@eulerxyz/euler-v2-sdk/public-labels'
import { __setEulerLabelsDataForTest } from '~/composables/useEulerLabels'
import * as geo from '~/composables/useGeoBlock'

const registry = vi.hoisted(() => new Map<string, { address: string, chainId: number, asset: { address: string, symbol: string, name: string } }>())
vi.mock('~/composables/useVaultRegistry', () => ({ useVaultRegistry: () => ({ getVault: (address: string) => registry.get(address.toLowerCase()) }) }))
const chainId = ref(1)
const cozy = {
  address: '0x63bA834bFf27Dd1d80533a56cA27Aa058AAA1130', chainId: 1,
  asset: { address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', symbol: 'USDC', name: 'USD Coin' },
}
const collateral = {
  address: '0xCee57C0F5060063F6875CFF54225F814Db604150', chainId: 1,
  asset: { address: '0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599', symbol: 'WBTC', name: 'Wrapped BTC' },
}
const setPolicies = (policies: PublicGeoPolicy[] | undefined, policyChainId = chainId.value) => __setEulerLabelsDataForTest({
  geoContext: { chainId: policyChainId, policies, productByVault: { [cozy.address.toLowerCase()]: 'cozy-usdc' } },
  visibility: { [cozy.address.toLowerCase()]: { status: 'hidden', explorableLend: false, explorableBorrow: false, decidedBy: 'checks', reason: 'Liquidation cool-off outside accepted range' } },
})
const rule = (overrides: Partial<PublicGeoPolicy> = {}): PublicGeoPolicy => ({
  id: 'test', chainId: 1, productId: null, vaultAddress: null, assetAddress: null,
  policyType: 'block', countries: ['NL'], countriesResolved: ['NL'], reason: null, createdAt: '', ...overrides,
})

beforeEach(() => {
  chainId.value = 1
  vi.stubGlobal('useEulerAddresses', () => ({ chainId }))
  registry.clear()
  registry.set(collateral.address.toLowerCase(), collateral)
  geo.useGeoBlock().country.value = 'NL'
  setPolicies([])
})

describe('SDK-resolved portfolio vault outside discovery', () => {
  it('evaluates the real Cozy asset without requiring registry membership', () => {
    expect(geo.isVaultBlockedByCountry(cozy.address)).toBe(true)
    expect(geo.isVaultBlockedByCountry(cozy.address, { asset: cozy.asset })).toBe(false)
    expect(geo.isVaultBlockedByCountry(cozy)).toBe(false)
    expect(geo.isAnyVaultBlockedByCountry(collateral, cozy)).toBe(false)
    expect(geo.isVaultRestrictedByCountry(cozy)).toBe(false)
    expect(geo.getVaultGeoBlockReason(cozy)).toBeUndefined()
  })

  it.each([{}, { productId: 'cozy-usdc' }, { vaultAddress: cozy.address }, { assetAddress: cozy.asset.address }, { assetSymbols: ['USDC'] }, { assetNameRegex: '^USD Coin$' }])('retains matching rules: %j', (selector) => {
    setPolicies([rule(selector)])
    expect(geo.isVaultBlockedByCountry(cozy)).toBe(true)
    expect(geo.getVaultGeoBlockReason(cozy)).toBe('region')
  })

  it('does not label missing country or asset as a confirmed region restriction', () => {
    for (const country of [undefined, null]) {
      geo.useGeoBlock().country.value = country
      expect(geo.isVaultBlockedByCountry(cozy)).toBe(true)
      expect(geo.getVaultGeoBlockReason(cozy)).toBe('country-unavailable')
    }
    geo.useGeoBlock().country.value = 'NL'
    expect(geo.isVaultBlockedByCountry(cozy.address)).toBe(true)
    expect(geo.getVaultGeoBlockReason(cozy.address)).toBe('asset-unavailable')
    expect(geo.getVaultTags(cozy.address)).toEqual({ tags: [], disabled: true })
    expect(geo.isVaultRestrictedByCountry(cozy.address)).toBe(true)
  })

  it('preserves unavailable-policy exit behavior, acquisition safeguards and sanctions', () => {
    setPolicies(undefined)
    expect(geo.useGeoBlock().isPolicyAvailable.value).toBe(false)
    expect(geo.getVaultTags(cozy, 'swap-target')).toEqual({ tags: [], disabled: true })
    expect(geo.isVaultBlockedByCountry(cozy)).toBe(false)
    expect(geo.getVaultGeoBlockReason(cozy)).toBe('policy-unavailable')
    expect(geo.isVaultRestrictedByCountry(cozy, { counterpart: cozy.asset })).toBe(true)
    geo.useGeoBlock().country.value = 'IR'
    expect(geo.isVaultBlockedByCountry(cozy)).toBe(true)
    expect(geo.getVaultGeoBlockReason(cozy)).toBe('region')
  })

  it('rejects stale caller assets and stale policies during chain switching', () => {
    chainId.value = 8453
    setPolicies([])
    expect(geo.isVaultBlockedByCountry(cozy)).toBe(true)
    expect(geo.isVaultRestrictedByCountry(cozy)).toBe(true)
    expect(geo.getVaultGeoBlockReason(cozy)).toBe('chain-mismatch')
    const current = { ...cozy, chainId: 8453 }
    expect(geo.isVaultBlockedByCountry(current)).toBe(false)
    setPolicies([], 1)
    expect(geo.isVaultBlockedByCountry(current)).toBe(true)
    expect(geo.isVaultRestrictedByCountry(current)).toBe(true)
  })

  it('preserves simple exits when cold policy context has no chain yet', () => {
    __setEulerLabelsDataForTest({ geoContext: { chainId: null, policies: undefined, productByVault: {} } })
    expect(geo.isVaultBlockedByCountry(cozy)).toBe(false)
    expect(geo.isVaultRestrictedByCountry(cozy)).toBe(true)
    expect(geo.getVaultGeoUnavailableReason(cozy)).toBe('Compliance data unavailable. Please retry.')
  })

  it('retains static asset rules and distinguishes missing evidence in action copy', () => {
    __setEulerLabelsDataForTest({ assetBlocks: { [cozy.asset.address.toLowerCase()]: ['NL'] } })
    expect(geo.getVaultGeoBlockReason(cozy)).toBe('region')
    expect(geo.isVaultBlockedByCountry(cozy)).toBe(true)
    expect(geo.getVaultGeoUnavailableReason(cozy)).toBeUndefined()
    __setEulerLabelsDataForTest()
    expect(geo.isVaultBlockedByCountry(cozy)).toBe(false)
    expect(geo.getVaultGeoUnavailableReason(cozy.address)).toContain('Vault data is unavailable')
    geo.useGeoBlock().country.value = null
    expect(geo.getVaultGeoUnavailableReason(cozy)).toContain('country could not be determined')
  })

  it('blocks matching vault/product rules even when their asset is missing', () => {
    setPolicies([rule({ productId: 'cozy-usdc' })])
    expect(geo.getVaultGeoBlockReason(cozy.address)).toBe('region')
    expect(geo.getVaultGeoUnavailableReason(cozy.address)).toBeUndefined()
  })

  it('re-evaluates asset and country rules after chain changes', () => {
    setPolicies([rule({ chainId: 8453, assetAddress: cozy.asset.address })])
    expect(geo.isVaultBlockedByCountry(cozy)).toBe(false)
    chainId.value = 8453
    setPolicies([rule({ chainId: 8453, assetAddress: cozy.asset.address })])
    expect(geo.isVaultBlockedByCountry({ ...cozy, chainId: 8453 })).toBe(true)
    geo.useGeoBlock().country.value = 'GB'
    expect(geo.isVaultBlockedByCountry({ ...cozy, chainId: 8453 })).toBe(false)
  })
})
