<script setup lang="ts">
import type { EVault, EulerEarn, SecuritizeCollateralVault } from '~/entities/vault'
import { getVaultTypeLabel, getVaultTypeDescription } from '~/entities/vault/descriptions'
import { useModal } from '~/components/ui/composables/useModal'
import { VaultTypeInfoModal } from '#components'

const { type, vault } = defineProps<{
  type: string
  vault: EVault | EulerEarn | SecuritizeCollateralVault
}>()

const modal = useModal()
const { isVaultGovernorVerified, isEarnVaultOwnerVerified } = useVaults()

// Check if vault is verified by checking governorAdmin/owner matches declared entities
const isVerified = computed(() => {
  if (type === 'escrow') {
    return true
  }

  if (type === 'managed') {
    return isEarnVaultOwnerVerified(vault as EulerEarn)
  }

  // governed, ungoverned, securitize
  return isVaultGovernorVerified(vault as EVault)
})

const isWarning = computed(() => !isVerified.value || type === 'unknown')

const icon = computed(() => {
  if (isWarning.value) {
    return 'warning'
  }
  switch (type) {
    case 'governed':
    case 'managed':
      return 'bank'
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
  <div
    class="vault-type-chip flex gap-8 items-center py-8 px-12 rounded-8 cursor-pointer"
    :class="{ 'vault-type-chip--warning': isWarning }"
    @click="openModal"
  >
    <UiIcon
      class="mr-2 !w-20 !h-20"
      :name="icon"
    />
    {{ label }}
  </div>
</template>

<style scoped lang="scss">
.vault-type-chip {
  background-color: rgba(var(--accent-rgb), 0.15);
  color: var(--accent-600);

  [data-theme="dark"] & {
    background-color: rgba(var(--accent-rgb), 0.2);
    color: var(--accent-500);
  }

  &--warning {
    background-color: rgba(var(--error-rgb), 0.1);
    color: var(--error-500);

    [data-theme="dark"] & {
      background-color: rgba(var(--error-rgb), 0.1);
      color: var(--error-500);
    }
  }
}
</style>
