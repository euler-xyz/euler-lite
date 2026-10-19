import { getAddress } from 'viem'
import { isEVault, isEulerEarn, isSecuritizeCollateralVault, type Portfolio, type PortfolioPositionFilter, type VaultEntity } from '@eulerxyz/euler-v2-sdk'
import { useEulerLabels } from '~/composables/useEulerLabels'
import { useVaultRegistry } from '~/composables/useVaultRegistry'
import { isVisiblePortfolioPosition } from '~/utils/portfolioVisibility'

/** Populate held metadata before publishing positions, independently of discovery membership. */
export const hydrateHeldVaults = async (portfolio: Portfolio<VaultEntity>): Promise<void> => {
  const chainId = portfolio.account.chainId
  const { chainId: activeChainId } = useEulerAddresses()
  if (chainId !== activeChainId.value) return
  const { get, set, getOrFetch } = useVaultRegistry()
  const held = new Map<string, VaultEntity | undefined>()
  const add = (address: string | undefined, vault?: VaultEntity) => {
    if (!address) return
    const normalized = getAddress(address).toLowerCase()
    const existing = get(normalized)
    if (existing && !existing.portfolioOnly) return
    const resolved = vault?.chainId === chainId && vault.address.toLowerCase() === normalized && vault.asset?.address
      ? vault
      : undefined
    held.set(normalized, resolved ?? held.get(normalized))
  }

  for (const saving of portfolio.savings) add(saving.position.vaultAddress, saving.vault ?? saving.position.vault)
  for (const position of portfolio.borrows) {
    add(position.borrow.vaultAddress, position.borrowVault ?? position.borrow.vault)
    for (const collateral of position.collaterals ?? []) add(collateral.vaultAddress, collateral.vault)
    for (const address of position.collateralVaults) add(address, position.collateralVault?.address.toLowerCase() === address.toLowerCase() ? position.collateralVault : undefined)
    for (const collateral of position.borrow.liquidity?.collaterals ?? []) add(collateral.address, collateral.vault)
    for (const address of portfolio.account.getSubAccount(position.borrow.account)?.enabledCollaterals ?? []) add(address)
  }

  // Register populated SDK objects synchronously. Only unresolved entries need RPC.
  const unresolved: string[] = []
  for (const [address, vault] of held) {
    const type = vault && (isEVault(vault) ? 'evk' : isEulerEarn(vault) ? 'earn' : isSecuritizeCollateralVault(vault) ? 'securitize' : undefined)
    if (vault && type) set(address, vault, type, { verified: false, portfolioOnly: true }, chainId)
    else if (!get(address)) unresolved.push(address)
  }
  await Promise.all(unresolved.map(address => getOrFetch(address, { portfolioOnly: true })))
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
