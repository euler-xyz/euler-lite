import { getAddress, zeroAddress } from 'viem'
import { getEulerRouterGovernor } from '~/entities/oracle'
import type { EarnVault, SecuritizeVault, Vault } from './types'

/**
 * Pure data needed to decide whether a vault's on-chain governor (and, for
 * EVK vaults, the oracle router's governor; for Earn vaults, the owner)
 * matches the entities its product declares. Both the client UI
 * (composables/useVaults.ts) and the public is-known proxy
 * (server/utils/verified-vaults.ts) drive the same rule through this shape
 * so the two paths cannot drift.
 */
export interface VerificationLabels {
  /** entityKey → entity; lookup uses checksummed addresses on both sides. */
  entitiesByKey: Record<string, { addresses: Record<string, unknown> }>
  /**
   * Resolves the entity keys declared for the product that owns this vault.
   * - `undefined`: vault is not in any product
   * - `[]`: product exists but declares no entities (treated as match-all)
   * - `[...]`: product declares these entity keys
   */
  getDeclaredEntityKeys: (vaultAddress: string) => string[] | undefined
}

const matchesAnyDeclaredEntity = (
  address: string,
  declaredKeys: string[],
  entitiesByKey: VerificationLabels['entitiesByKey'],
): boolean => findDeclaredEntityFor(address, declaredKeys, entitiesByKey) !== null

const findDeclaredEntityFor = (
  address: string,
  declaredKeys: string[],
  entitiesByKey: VerificationLabels['entitiesByKey'],
): string | null => declaredKeys.find((key) => {
  const entity = entitiesByKey[key]
  return !!entity && Object.keys(entity.addresses).includes(address)
}) ?? null

export const isVaultGovernorVerified = (
  vault: Vault | SecuritizeVault,
  labels: VerificationLabels,
): boolean => {
  // Escrow vaults have no risk manager — labels treat them as a separate
  // trust anchor (EscrowedCollateralPerspective), no entity matching applies.
  if ('vaultCategory' in vault && vault.vaultCategory === 'escrow') return true

  if (!vault.verified) return false

  const declaredKeys = labels.getDeclaredEntityKeys(vault.address)
  if (declaredKeys === undefined) return false
  if (declaredKeys.length === 0) return true

  if (!matchesAnyDeclaredEntity(vault.governorAdmin, declaredKeys, labels.entitiesByKey)) {
    return false
  }

  if ('oracleDetailedInfo' in vault) {
    const routerGovernor = getEulerRouterGovernor(vault.oracleDetailedInfo)
    if (routerGovernor && routerGovernor !== zeroAddress) {
      if (!matchesAnyDeclaredEntity(routerGovernor, declaredKeys, labels.entitiesByKey)) {
        return false
      }
    }
  }

  return true
}

export const isEarnVaultOwnerVerified = (
  earnVault: EarnVault,
  labels: VerificationLabels,
): boolean => {
  if (!earnVault.verified) return false

  const declaredKeys = labels.getDeclaredEntityKeys(earnVault.address)
  // Earn vaults without a product entry are trusted on the strength of being
  // in earn-vaults.json alone — earn curation lives in that file, not in
  // products.json. Differs from EVK behaviour.
  if (declaredKeys === undefined) return true
  if (declaredKeys.length === 0) return true

  return matchesAnyDeclaredEntity(getAddress(earnVault.owner), declaredKeys, labels.entitiesByKey)
}

/**
 * Returns the declared entity key whose addresses contain the vault's
 * governorAdmin. Companion to `isVaultGovernorVerified` — answers "which
 * entity is the risk manager?" rather than "is the vault verified?". The
 * router-governor gate is NOT consulted here (it's a verification rule, not
 * an entity-identity question), so callers needing the full verdict should
 * compose with `isVaultGovernorVerified` / `getVerifiedAddressSet`.
 */
export const resolveGoverningEntityKey = (
  vault: Vault | SecuritizeVault,
  labels: VerificationLabels,
): string | null => {
  if ('vaultCategory' in vault && vault.vaultCategory === 'escrow') return null
  if (!vault.verified) return null
  const declaredKeys = labels.getDeclaredEntityKeys(vault.address)
  if (!declaredKeys || declaredKeys.length === 0) return null
  return findDeclaredEntityFor(vault.governorAdmin, declaredKeys, labels.entitiesByKey)
}

export const resolveEarnGoverningEntityKey = (
  earnVault: EarnVault,
  labels: VerificationLabels,
): string | null => {
  if (!earnVault.verified) return null
  const declaredKeys = labels.getDeclaredEntityKeys(earnVault.address)
  if (!declaredKeys || declaredKeys.length === 0) return null
  return findDeclaredEntityFor(getAddress(earnVault.owner), declaredKeys, labels.entitiesByKey)
}
