<script setup lang="ts">
import type { EarnVault } from '~/entities/vault'

const emits = defineEmits<{
  'vault-click': [address: string]
}>()
const { vault } = defineProps<{ vault: EarnVault, desktopOverview?: boolean }>()
</script>

<template>
  <div
    class="flex flex-col"
  >
    <VaultOverviewEarnBlockGeneral
      :vault="vault"
    />

    <VaultOverviewEarnBlockStats
      :vault="vault"
    />

    <VaultOverviewEarnBlockExposure
      :vault="vault"
      @vault-click="(address: string) => emits('vault-click', address)"
    />

    <VaultOverviewEarnBlockManagement
      :vault="vault"
    />

    <VaultOverviewEarnBlockAddresses
      :vault="vault"
    />
  </div>
</template>
