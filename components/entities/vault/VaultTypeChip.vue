<script setup lang="ts">
import type { Vault, EarnVault, SecuritizeVault } from '~/entities/vault'
import { getVaultTypeLabel, getVaultTypeDescription } from '~/entities/vault/descriptions'
import { useModal } from '~/components/ui/composables/useModal'
import { VaultTypeInfoModal } from '#components'

const { type, vault, size = 'small', block = false, as = 'span', nudge = false } = defineProps<{
  type: string
  vault: Vault | EarnVault | SecuritizeVault
  size?: 'small' | 'large'
  block?: boolean
  as?: 'button' | 'span'
  nudge?: boolean
}>()

const modal = useModal()
const { isVaultGovernorVerified, isEarnVaultOwnerVerified } = useVaults()

// Check if vault is verified by checking governorAdmin/owner matches declared entities
const isVerified = computed(() => {
  if (type === 'escrow') {
    return true
  }

  if (type === 'managed') {
    return isEarnVaultOwnerVerified(vault as EarnVault)
  }

  // governed, ungoverned, securitize
  return isVaultGovernorVerified(vault as Vault)
})

const isWarning = computed(() => !isVerified.value || type === 'unknown')

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
  return getVaultTypeLabel(type, isVerified.value)
})

const effectiveType = computed(() => isVerified.value ? type : 'unknown')

const tone = computed(() => {
  if (isWarning.value) return 'danger'
  if (type === 'governed' || type === 'ungoverned' || type === 'managed') return 'governance'
  return 'neutral'
})

const openModal = () => {
  modal.open(VaultTypeInfoModal, {
    props: {
      title: getVaultTypeLabel(effectiveType.value, isVerified.value),
      description: getVaultTypeDescription(effectiveType.value, isVerified.value),
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
