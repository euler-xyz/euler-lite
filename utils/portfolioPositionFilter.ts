import { getAddress } from 'viem'
import type { PortfolioPositionFilter, VaultEntity } from '@eulerxyz/euler-v2-sdk'
import { useEulerLabels } from '~/composables/useEulerLabels'
import { useVaultRegistry } from '~/composables/useVaultRegistry'
import { isVisiblePortfolioPosition } from '~/utils/portfolioVisibility'

export const buildVisiblePortfolioPositionFilter = (): PortfolioPositionFilter<VaultEntity> => {
  const { verifiedVaultAddresses, earnVaults } = useEulerLabels()
  const { escrowAddresses, getEscrowVaults } = useVaultRegistry()

  const visibleVaults = new Set<string>()
  for (const vault of verifiedVaultAddresses.value) visibleVaults.add(getAddress(vault).toLowerCase())
  for (const vault of earnVaults.value) visibleVaults.add(getAddress(vault).toLowerCase())
  for (const vault of escrowAddresses.value) visibleVaults.add(getAddress(vault).toLowerCase())
  for (const vault of getEscrowVaults()) visibleVaults.add(getAddress(vault.address).toLowerCase())

  return (position, { account }) => isVisiblePortfolioPosition(position, account, visibleVaults)
}
