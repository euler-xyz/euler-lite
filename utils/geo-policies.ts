import type { PublicGeoPolicy } from '@eulerxyz/euler-v2-sdk/public-labels'

export interface HostedGeoContext {
  chainId: number | null
  /** Undefined means unavailable; [] is an authored empty collection. */
  policies: PublicGeoPolicy[] | undefined
  productByVault: Record<string, string | null>
}

type Asset = { address?: string, symbol?: string, name?: string }
const patterns = new Map<string, RegExp>()
const patternMatches = (pattern: string | null | undefined, input: string | undefined): boolean => {
  if (!pattern || !input) return false
  // Preserve the conservative legacy guard without evaluating unbounded token metadata.
  if (input.length > 128) return true
  let compiled = patterns.get(pattern)
  if (!compiled) {
    compiled = new RegExp(pattern, 'i')
    if (patterns.size >= 1000) patterns.clear()
    patterns.set(pattern, compiled)
  }
  return compiled.test(input)
}

export const isAssetGeoPolicy = (policy: PublicGeoPolicy): boolean =>
  policy.assetAddress !== null || policy.assetSymbols != null || policy.assetNames != null
  || policy.assetSymbolRegex != null || policy.assetNameRegex != null

/** All matching rules accumulate. Selectors within the asset matcher are alternatives. */
export const matchesHostedGeo = (
  context: HostedGeoContext,
  country: string,
  type: PublicGeoPolicy['policyType'],
  asset: Asset | undefined,
  vaultAddress?: string,
  scope: 'all' | 'asset' | 'non-asset' = 'all',
): boolean => (context.policies ?? []).some((policy) => {
  if (policy.policyType !== type || !policy.countriesResolved.includes(country.toUpperCase())) return false
  if (policy.chainId !== null && policy.chainId !== context.chainId) return false
  const vault = vaultAddress?.toLowerCase()
  if (policy.vaultAddress && policy.vaultAddress.toLowerCase() !== vault) return false
  if (policy.productId && (!vault || context.productByVault[vault] !== policy.productId)) return false
  const assetRule = isAssetGeoPolicy(policy)
  if (scope === 'asset' && !assetRule) return false
  if (scope === 'non-asset' && assetRule) return false
  if (!assetRule) return true
  if (!asset) return false
  return Boolean(
    (policy.assetAddress && policy.assetAddress.toLowerCase() === asset.address?.toLowerCase())
    || policy.assetSymbols?.some(value => value.toLowerCase() === asset.symbol?.toLowerCase())
    || policy.assetNames?.some(value => value.toLowerCase() === asset.name?.toLowerCase())
    || patternMatches(policy.assetSymbolRegex, asset.symbol)
    || patternMatches(policy.assetNameRegex, asset.name),
  )
})
