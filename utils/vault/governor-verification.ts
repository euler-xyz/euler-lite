import { getAddress, zeroAddress, type Address } from 'viem'
import type { EulerEarn, OracleDetailedInfo, isEVault, type EVault } from '@eulerxyz/euler-v2-sdk'
import { getEulerRouterGovernor } from '~/entities/oracle'

/**
 * Value-based governance hydration guard. SDK 2.0 EVault instances always
 * OWN the `governorAdmin` property — the constructor assigns it even when
 * governance was never fetched — so an `in`-operator check passes on every
 * real instance and misreads lazily-hydrated vaults as "governance resolved
 * to nothing", producing false Unknown badges. Only a defined value means
 * governance actually resolved.
 */
export const hasResolvedGovernorAdmin = (vault: unknown): vault is EVault =>
  isEVault(vault) && vault.governorAdmin !== undefined

interface VerifiableVault {
  address: string
  governorAdmin?: string
  governor?: string
  oracleDetailedInfo?: OracleDetailedInfo | null
  verified?: boolean
  vaultCategory?: 'standard' | 'escrow'
}

type VerifiableEarnVault = EulerEarn & {
  verified?: boolean
}

/**
 * Pure data needed to decide whether a vault's on-chain governor (and, for
 * EVK vaults, the oracle router's governor; for Earn vaults, the owner)
 * matches the entities its product declares. Both the client UI
 * (composables/useVaults.ts) and the public is-known proxy
 * (server/utils/verified-vaults.ts) drive the same rule through this shape
 * so the two paths cannot drift.
 *
 * Callbacks let each side back the rule with whatever data structure it
 * already has (the client reads off the reactive labels store; the server
 * builds Sets at cache-construction time). Addresses passed to
 * `hasEntityAddress` are always checksummed by the rule.
 */
export interface VerificationLabels {
  /**
   * Resolves the entity keys declared for the product that owns this vault.
   * - `undefined`: vault is not in any product
   * - `[]`: product exists but declares no entities — treated as unverified
   *   (a product without a declared entity has no on-chain authority to claim)
   * - `[...]`: product declares these entity keys
   */
  getDeclaredEntityKeys: (vaultAddress: string) => string[] | undefined
  /** Returns true if `address` (checksummed) is one of `entityKey`'s declared addresses. */
  hasEntityAddress: (entityKey: string, address: Address) => boolean
}

const findDeclaredEntityFor = (
  address: Address,
  declaredKeys: string[],
  labels: VerificationLabels,
): string | null => declaredKeys.find(key => labels.hasEntityAddress(key, address)) ?? null

const findAllDeclaredEntitiesFor = (
  address: Address,
  declaredKeys: string[],
  labels: VerificationLabels,
): string[] => declaredKeys.filter(key => labels.hasEntityAddress(key, address))

export const isVaultGovernorVerified = (
  vault: VerifiableVault,
  labels: VerificationLabels,
): boolean => {
  // Escrow vaults have no risk manager — labels treat them as a separate
  // trust anchor (EscrowedCollateralPerspective), no entity matching applies.
  if ('vaultCategory' in vault && vault.vaultCategory === 'escrow') return true

  if (!vault.verified) return false

  const declaredKeys = labels.getDeclaredEntityKeys(vault.address)
  // No product, or a product with no declared entity, both fail verification.
  // A product without a declared entity has no on-chain authority to claim
  // the vault — treat it the same as a vault outside any product.
  if (!declaredKeys || declaredKeys.length === 0) return false

  const governor = vault.governorAdmin ?? vault.governor
  if (!governor) return false

  if (!findDeclaredEntityFor(getAddress(governor), declaredKeys, labels)) {
    return false
  }

  if ('oracleDetailedInfo' in vault) {
    const routerGovernor = getEulerRouterGovernor(vault.oracleDetailedInfo)
    if (routerGovernor && routerGovernor !== zeroAddress) {
      if (!findDeclaredEntityFor(getAddress(routerGovernor), declaredKeys, labels)) {
        return false
      }
    }
  }

  return true
}

export const isEarnVaultOwnerVerified = (
  earnVault: VerifiableEarnVault,
  labels: VerificationLabels,
): boolean => {
  if (!earnVault.verified) return false

  const declaredKeys = labels.getDeclaredEntityKeys(earnVault.address)
  // Earn vaults outside any product are trusted on the strength of being in
  // earn-vaults.json alone — earn curation lives in that file, not in
  // products.json. Differs from EVK behaviour.
  if (declaredKeys === undefined) return true
  // But if the earn vault IS in a product whose entity is empty/undefined,
  // the product has no on-chain authority to claim it — treat as unverified.
  if (declaredKeys.length === 0) return false

  return findDeclaredEntityFor(getAddress(earnVault.governance.owner), declaredKeys, labels) !== null
}

/**
 * Returns every declared entity key whose addresses contain the vault's
 * governorAdmin, in declared-key order. Companion to `isVaultGovernorVerified`
 * — answers "which entities are the risk managers?" rather than "is the vault
 * verified?". A product may declare multiple entities and more than one can
 * match; the empty array is returned when none match (or the vault is escrow,
 * unverified, or not in any product). The router-governor gate is NOT consulted
 * here (it's a verification rule, not an entity-identity question), so callers
 * needing the full verdict should compose with `isVaultGovernorVerified` /
 * `getVerifiedAddressSet`.
 */
export const resolveGoverningEntityKeys = (
  vault: VerifiableVault,
  labels: VerificationLabels,
): string[] => {
  if ('vaultCategory' in vault && vault.vaultCategory === 'escrow') return []
  if (!vault.verified) return []
  const declaredKeys = labels.getDeclaredEntityKeys(vault.address)
  if (!declaredKeys || declaredKeys.length === 0) return []
  const governor = vault.governorAdmin ?? vault.governor
  return governor ? findAllDeclaredEntitiesFor(getAddress(governor), declaredKeys, labels) : []
}

export const resolveEarnGoverningEntityKeys = (
  earnVault: VerifiableEarnVault,
  labels: VerificationLabels,
): string[] => {
  if (!earnVault.verified) return []
  const declaredKeys = labels.getDeclaredEntityKeys(earnVault.address)
  if (!declaredKeys || declaredKeys.length === 0) return []
  return findAllDeclaredEntitiesFor(getAddress(earnVault.governance.owner), declaredKeys, labels)
}
