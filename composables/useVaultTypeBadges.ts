import { zeroAddress } from 'viem'
import { isEVault, type EulerEarn, type EVault, type SecuritizeCollateralVault } from '@eulerxyz/euler-v2-sdk'
import type { Ref } from 'vue'
import { isCyclicalNoteVault } from '~/utils/vault/classification'
import { useEulerProductOfVault } from '~/composables/useEulerLabels'
import { getEntitiesByEarnVault, getEntitiesByVault, isVaultKeyring } from '~/utils/eulerLabelsUtils'
import { useVaultRegistry } from '~/composables/useVaultRegistry'

type VaultTypeBadgeVault = EVault | EulerEarn | SecuritizeCollateralVault

export type VaultGovernanceBadge = 'governed' | 'managed' | 'escrow' | 'ungoverned' | 'unknown'
export type VaultTypeBadge = VaultGovernanceBadge | 'securitize' | 'private' | 'governanceLimited' | 'cyclicalNote'
export type VaultTypeSummaryBadge = Extract<VaultTypeBadge, 'cyclicalNote' | 'private' | 'unknown'>

export const useVaultTypeBadges = (vault: Ref<VaultTypeBadgeVault>) => {
  const { isVaultGovernorVerified, isEarnVaultOwnerVerified } = useVaults()
  const { getVaultCategory, isVerifiedVault } = useVaultRegistry()

  const addressRef = computed(() => vault.value.address)
  const product = useEulerProductOfVault(addressRef)

  const isEarn = computed(() => vault.value.type === 'EulerEarn')
  const isSecuritize = computed(() => vault.value.type === 'SecuritizeCollateral')

  const entities = computed(() => {
    if (isEarn.value) return getEntitiesByEarnVault(vault.value as EulerEarn)
    return getEntitiesByVault(vault.value as EVault | SecuritizeCollateralVault)
  })

  const isVerified = computed(() => {
    if (isEarn.value) return isEarnVaultOwnerVerified(vault.value as EulerEarn)
    if (isSecuritize.value) return isVerifiedVault(vault.value.address)
    return isVaultGovernorVerified(vault.value as EVault)
  })

  const governanceType = computed<VaultGovernanceBadge>(() => {
    if (isEarn.value) {
      return entities.value.length ? 'managed' : 'unknown'
    }

    if (isEVault(vault.value) && getVaultCategory(vault.value.address) === 'escrow') return 'escrow'
    const governor = isSecuritize.value
      ? (vault.value as SecuritizeCollateralVault).governor
      : (vault.value as EVault).governorAdmin
    if (!governor) return 'unknown'
    if (governor.toLowerCase() === zeroAddress) return 'ungoverned'
    return entities.value.length ? 'governed' : 'unknown'
  })

  const isGovernanceLimited = computed(() =>
    product.isGovernanceLimited && isVerified.value,
  )

  const isCyclicalNote = computed(() => {
    if (!isEVault(vault.value)) return false
    return isCyclicalNoteVault(vault.value)
  })

  const badges = computed<VaultTypeBadge[]>(() => {
    const result: VaultTypeBadge[] = [governanceType.value]

    if (isVerified.value && isSecuritize.value) result.push('securitize')
    if (isVerified.value && isVaultKeyring(vault.value.address)) result.push('private')
    if (isGovernanceLimited.value) result.push('governanceLimited')
    if (isVerified.value && isCyclicalNote.value) result.push('cyclicalNote')

    return result
  })

  const summaryBadges = computed<VaultTypeSummaryBadge[]>(() => {
    const result: VaultTypeSummaryBadge[] = []

    if (!isVerified.value || governanceType.value === 'unknown') result.push('unknown')
    if (badges.value.includes('private')) result.push('private')
    if (badges.value.includes('cyclicalNote')) result.push('cyclicalNote')

    return result
  })

  const hasSummaryBadges = computed(() => summaryBadges.value.length > 0)
  const summaryGovernanceType = computed<VaultGovernanceBadge>(() =>
    summaryBadges.value.includes('unknown') ? 'unknown' : governanceType.value,
  )

  return {
    badges,
    governanceType,
    hasSummaryBadges,
    isVerified,
    summaryBadges,
    summaryGovernanceType,
  }
}
