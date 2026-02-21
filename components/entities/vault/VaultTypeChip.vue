<script setup lang="ts">
import type { Vault, EarnVault, SecuritizeVault } from '~/entities/vault'

const { type, vault } = defineProps<{
  type: string
  vault: Vault | EarnVault | SecuritizeVault
}>()

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
  if (!isVerified.value) {
    return 'Unknown'
  }
  switch (type) {
    case 'governed':
      return 'Governed'
    case 'managed':
      return 'Managed'
    case 'escrow':
      return 'Escrowed collateral'
    case 'securitize':
      return 'Securitize Digital Security'
    case 'ungoverned':
      return 'Ungoverned'
    case 'unknown':
      return 'Unknown'
  }

  return 'Unknown'
})
</script>

<template>
  <div
    class="vault-type-chip flex gap-8 items-center py-8 px-12 rounded-8"
    :class="{ 'vault-type-chip--warning': isWarning }"
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
  background-color: rgba(var(--accent-500-rgb), 0.1);
  color: var(--accent-600);

  [data-theme="dark"] & {
    background-color: rgba(var(--accent-500-rgb), 0.15);
    color: var(--accent-500);
  }

  &--warning {
    background-color: var(--c-red-opaque-200);
    color: var(--c-red-700);

    [data-theme="dark"] & {
      background-color: var(--c-red-opaque-200);
      color: var(--c-red-700);
    }
  }
}
</style>
