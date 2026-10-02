import { getAddress } from 'viem'
import type { PortfolioPositionFilter, VaultEntity } from '@eulerxyz/euler-v2-sdk'
import { useEulerLabels } from '~/composables/useEulerLabels'
import { useVaultRegistry } from '~/composables/useVaultRegistry'
import { isVisiblePortfolioPosition } from '~/utils/portfolioVisibility'

export const buildVisiblePortfolioPositionFilter = (): PortfolioPositionFilter<VaultEntity> => {
  const { verifiedVaultAddresses, earnVaults, vaultCandidates, earnCandidates, visibility, source } = useEulerLabels()
  const { escrowAddresses, getEscrowVaults, isVerifiedVault } = useVaultRegistry()

  const visibleVaults = new Set<string>()
  for (const vault of verifiedVaultAddresses.value) visibleVaults.add(getAddress(vault).toLowerCase())
  for (const vault of earnVaults.value) visibleVaults.add(getAddress(vault).toLowerCase())
  if (source.value === 'v3-metadata') {
    // Metadata-only chains have candidates but no published verified set.
    // The registry resolves their governor/owner against the current labels.
    for (const vault of [...vaultCandidates.value, ...earnCandidates.value]) {
      if (isVerifiedVault(vault)) visibleVaults.add(getAddress(vault).toLowerCase())
    }
  }
  if (source.value === 'v3') {
    for (const [address, verdict] of Object.entries(visibility.value ?? {})) {
      if (verdict.status === 'hidden' || verdict.status === 'pending_review') {
        visibleVaults.add(address.toLowerCase())
      }
    }
  }
  for (const vault of escrowAddresses.value) visibleVaults.add(getAddress(vault).toLowerCase())
  for (const vault of getEscrowVaults()) visibleVaults.add(getAddress(vault.address).toLowerCase())

  return (position, { account }) => isVisiblePortfolioPosition(position, account, visibleVaults)
}
