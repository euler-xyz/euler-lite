import { zeroAddress } from 'viem'
import { isEVault, type EulerEarn, type EVault, type SecuritizeCollateralVault } from '@eulerxyz/euler-v2-sdk'
import type { Ref } from 'vue'
import { getEntitiesByEarnVault, getEntitiesByVault, isVaultAccessControlled, isVaultCyclicalNote, isVaultGovernanceLimited, isVaultKeyring } from '~/utils/eulerLabelsUtils'
import { useVaultRegistry } from '~/composables/useVaultRegistry'

type VaultTypeBadgeVault = EVault | EulerEarn | SecuritizeCollateralVault

export type VaultGovernanceBadge = 'governed' | 'managed' | 'escrow' | 'ungoverned' | 'unknown'
export type VaultTypeBadge = VaultGovernanceBadge | 'securitize' | 'private' | 'accessControl' | 'governanceLimited' | 'cyclicalNote'
export type VaultTypeSummaryBadge = Extract<VaultTypeBadge, 'cyclicalNote' | 'private' | 'accessControl' | 'unknown'>

export const useVaultTypeBadges = (vault: Ref<VaultTypeBadgeVault>) => {
  const { isVaultGovernorVerified, isSecuritizeGovernorVerified, isEarnVaultOwnerVerified } = useVaults()
  const { getVaultCategory } = useVaultRegistry()

  const addressRef = computed(() => vault.value.address)

  const isEarn = computed(() => vault.value.type === 'EulerEarn')
  const isSecuritize = computed(() => vault.value.type === 'SecuritizeCollateral')

  const entities = computed(() => {
    if (isEarn.value) return getEntitiesByEarnVault(vault.value as EulerEarn)
    return getEntitiesByVault(vault.value as EVault | SecuritizeCollateralVault)
  })

  const isVerified = computed(() => {
    if (isEarn.value) return isEarnVaultOwnerVerified(vault.value as EulerEarn)
    if (isSecuritize.value) return isSecuritizeGovernorVerified(vault.value as SecuritizeCollateralVault)
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
    isVaultGovernanceLimited(addressRef.value) && isVerified.value,
  )

  const isCyclicalNote = computed(() => {
    if (!isEVault(vault.value)) return false
    return isVaultCyclicalNote(vault.value.address)
  })

  const shouldSummarizeAsUnknown = computed(() =>
    governanceType.value === 'unknown'
    || (!isVerified.value && !['escrow', 'ungoverned'].includes(governanceType.value)),
  )

  const badges = computed<VaultTypeBadge[]>(() => {
    const result: VaultTypeBadge[] = [governanceType.value]

    if (isVerified.value && isSecuritize.value) result.push('securitize')
    if (isVerified.value && isVaultKeyring(vault.value.address)) result.push('private')
    if (isVerified.value && isVaultAccessControlled(vault.value.address)) result.push('accessControl')
    if (isGovernanceLimited.value) result.push('governanceLimited')
    if (isVerified.value && isCyclicalNote.value) result.push('cyclicalNote')

    return result
  })

  const summaryBadges = computed<VaultTypeSummaryBadge[]>(() => {
    const result: VaultTypeSummaryBadge[] = []

    if (shouldSummarizeAsUnknown.value) result.push('unknown')
    if (badges.value.includes('private')) result.push('private')
    if (badges.value.includes('accessControl')) result.push('accessControl')
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
