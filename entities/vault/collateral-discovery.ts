import { getAddress, zeroAddress } from 'viem'
import type { Vault } from './types'
import { isLiveCollateralEdge } from './ltv'

/**
 * Pure helper: from a list of EVK vaults, return the unique set of
 * collateral addresses that are referenced by *live* edges but are NOT
 * present in the registry yet.
 *
 * "Live" matches the {@link isLiveCollateralEdge} contract — non-zero
 * borrow LTV OR non-zero current ramped liquidation LTV. We don't fetch
 * collaterals for fully ramped-out edges.
 *
 * Addresses are normalised via `getAddress` so the caller can hand them
 * straight to the registry without re-normalising.
 *
 * Extracted from `composables/useVaults.ts` so the resolution logic is
 * testable in isolation from the reactive registry.
 */
export const extractUnresolvedCollateralAddresses = (
  evkVaults: readonly Vault[],
  isInRegistry: (address: string) => boolean,
  nowSeconds?: bigint,
): string[] => {
  const unresolved = new Set<string>()
  evkVaults.forEach((vault) => {
    vault.collateralLTVs.forEach((ltv) => {
      if (!isLiveCollateralEdge(ltv, nowSeconds)) return
      const addr = ltv.collateral
      if (addr === zeroAddress) return
      if (isInRegistry(addr)) return
      unresolved.add(getAddress(addr))
    })
  })
  return [...unresolved]
}
