import { getAddress } from 'viem'
import type { Portfolio, PortfolioPositionFilter, VaultEntity } from '@eulerxyz/euler-v2-sdk'
import { useEulerLabels } from '~/composables/useEulerLabels'
import { useVaultRegistry } from '~/composables/useVaultRegistry'
import { isVisiblePortfolioPosition } from '~/utils/portfolioVisibility'

export const hydrateHeldMetadataVaults = async (portfolio: Portfolio<VaultEntity>): Promise<void> => {
  const { source, vaultCandidates, earnCandidates } = useEulerLabels()
  if (source.value !== 'v3-metadata') return

  const { get, getOrFetch } = useVaultRegistry()
  const candidates = new Set([...vaultCandidates.value, ...earnCandidates.value].map(address => getAddress(address).toLowerCase()))
  const held = new Set<string>()
  const addCandidate = (address: string | undefined) => {
    if (!address) return
    const normalized = getAddress(address).toLowerCase()
    if (candidates.has(normalized) && !get(normalized)) held.add(normalized)
  }

  for (const saving of portfolio.savings) addCandidate(saving.position.vaultAddress)
  for (const borrow of portfolio.borrows) {
    addCandidate(borrow.borrow.vaultAddress)
    for (const collateral of borrow.collateralVaults) addCandidate(collateral)
    for (const collateral of borrow.borrow.liquidity?.collaterals ?? []) addCandidate(collateral.address)
    for (const collateral of portfolio.account.getSubAccount(borrow.borrow.account)?.enabledCollaterals ?? []) addCandidate(collateral)
  }
  await Promise.all([...held].map(address => getOrFetch(address)))
}

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
