import { zeroAddress } from 'viem'
import type { Ref } from 'vue'
import type { EarnVault, SecuritizeVault, Vault } from '~/entities/vault'
import { isCyclicalNoteVault } from '~/entities/vault'
import { useEulerProductOfVault } from '~/composables/useEulerLabels'
import { getEntitiesByEarnVault, getEntitiesByVault, isVaultKeyring } from '~/utils/eulerLabelsUtils'

type VaultTypeBadgeVault = EarnVault | SecuritizeVault | Vault

export type VaultGovernanceBadge = 'governed' | 'managed' | 'escrow' | 'ungoverned' | 'unknown'
export type VaultTypeBadge = VaultGovernanceBadge | 'securitize' | 'private' | 'governanceLimited' | 'cyclicalNote'
export type VaultTypeSummaryBadge = Extract<VaultTypeBadge, 'cyclicalNote' | 'private' | 'unknown'>

export const useVaultTypeBadges = (vault: Ref<VaultTypeBadgeVault>) => {
  const { isVaultGovernorVerified, isEarnVaultOwnerVerified } = useVaults()

  const addressRef = computed(() => vault.value.address)
  const product = useEulerProductOfVault(addressRef)

  const isEarn = computed(() => 'type' in vault.value && vault.value.type === 'earn')
  const isSecuritize = computed(() => 'type' in vault.value && vault.value.type === 'securitize')

  const entities = computed(() => {
    if (isEarn.value) return getEntitiesByEarnVault(vault.value as EarnVault)
    return getEntitiesByVault(vault.value as Vault | SecuritizeVault)
  })

  const isVerified = computed(() => {
    if (isEarn.value) return isEarnVaultOwnerVerified(vault.value as EarnVault)
    return isVaultGovernorVerified(vault.value as Vault | SecuritizeVault)
  })

  const governanceType = computed<VaultGovernanceBadge>(() => {
    if (isEarn.value) {
      return entities.value.length ? 'managed' : 'unknown'
    }

    const v = vault.value as Vault | SecuritizeVault
    if ('vaultCategory' in v && v.vaultCategory === 'escrow') return 'escrow'
    if (!v.governorAdmin) return 'unknown'
    if (v.governorAdmin.toLowerCase() === zeroAddress) return 'ungoverned'
    return entities.value.length ? 'governed' : 'unknown'
  })

  const isGovernanceLimited = computed(() =>
    product.isGovernanceLimited && isVerified.value,
  )

  const isCyclicalNote = computed(() => {
    if (isEarn.value || isSecuritize.value) return false
    return isCyclicalNoteVault(vault.value as Vault)
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

  return {
    badges,
    governanceType,
    hasSummaryBadges,
    isVerified,
    summaryBadges,
  }
}
