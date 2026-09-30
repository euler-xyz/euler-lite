<script setup lang="ts">
import { isEVault, type EVault, type EulerEarn, type SecuritizeCollateralVault } from '@eulerxyz/euler-v2-sdk'
import { zeroAddress } from 'viem'
import { getVaultTypeLabel, getVaultTypeDescription } from '~/utils/vault/descriptions'
import { useModal } from '~/components/ui/composables/useModal'
import { VaultTypeInfoModal } from '#components'

const { type, vault, size = 'small', block = false, as = 'span', nudge = false } = defineProps<{
  type: string
  vault: EVault | EulerEarn | SecuritizeCollateralVault
  size?: 'small' | 'large'
  block?: boolean
  as?: 'button' | 'span'
  nudge?: boolean
}>()

const modal = useModal()
const { isVaultGovernorVerified, isSecuritizeGovernorVerified, isEarnVaultOwnerVerified } = useVaults()

// Check if vault is verified by checking governorAdmin/owner matches declared entities
const isVerified = computed(() => {
  if (type === 'escrow') {
    return true
  }

  if (type === 'managed') {
    return isEarnVaultOwnerVerified(vault as EulerEarn)
  }

  if (type === 'securitize') {
    return isSecuritizeGovernorVerified(vault as SecuritizeCollateralVault)
  }

  // governed, ungoverned, securitize
  return isVaultGovernorVerified(vault as EVault)
})

const isKnownUngoverned = computed(() => type === 'ungoverned' && (
  isEVault(vault)
    ? vault.governorAdmin?.toLowerCase() === zeroAddress
    : 'governor' in vault && vault.governor?.toLowerCase() === zeroAddress
))
const hasKnownGovernanceType = computed(() => isVerified.value || isKnownUngoverned.value)

const isWarning = computed(() => !hasKnownGovernanceType.value || type === 'unknown')

const icon = computed(() => {
  if (isWarning.value) {
    return 'warning'
  }
  switch (type) {
    case 'governed':
    case 'managed':
      return 'governed'
    case 'escrow':
    case 'securitize':
      return 'shield'
    case 'ungoverned':
      return 'pulse'
  }

  return 'pulse'
})

const label = computed(() => {
  return getVaultTypeLabel(type, hasKnownGovernanceType.value)
})

const effectiveType = computed(() => hasKnownGovernanceType.value ? type : 'unknown')

const tone = computed(() => {
  if (isWarning.value) return 'danger'
  if (type === 'securitize') return 'accent'
  if (type === 'governed' || type === 'ungoverned' || type === 'managed') return 'governance'
  return 'neutral'
})

const openModal = () => {
  modal.open(VaultTypeInfoModal, {
    props: {
      title: getVaultTypeLabel(effectiveType.value, hasKnownGovernanceType.value),
      description: getVaultTypeDescription(effectiveType.value, hasKnownGovernanceType.value),
    },
  })
}
</script>

<template>
  <VaultMetadataTag
    :as="as"
    :icon="icon"
    :label="label"
    :tone="tone"
    :size="size"
    :block="block"
    :nudge="nudge"
    @click="openModal"
  />
</template>
