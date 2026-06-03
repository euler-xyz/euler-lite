import { getAddress, zeroAddress } from 'viem'
import type { EVault } from '@eulerxyz/euler-v2-sdk'
import { isLiveCollateralEdge } from './ltv'

/**
 * Pure helper: from a list of EVaults, return the unique set of
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
  eVaults: readonly EVault[],
  isInRegistry: (address: string) => boolean,
): string[] => {
  const unresolved = new Set<string>()
  eVaults.forEach((vault) => {
    vault.collaterals.forEach((ltv) => {
      if (!isLiveCollateralEdge(ltv)) return
      const addr = ltv.address
      if (addr === zeroAddress) return
      const normalised = getAddress(addr)
      if (isInRegistry(normalised)) return
      unresolved.add(normalised)
    })
  })
  return [...unresolved]
}
