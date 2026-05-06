<script setup lang="ts">
import type { EulerEarn } from '@eulerxyz/euler-v2-sdk'

const emits = defineEmits<{
  'vault-click': [address: string]
}>()
const { vault } = defineProps<{ vault: EulerEarn, desktopOverview?: boolean }>()
</script>

<template>
  <div
    class="flex flex-col"
    :class="[desktopOverview ? 'gap-16' : 'gap-12']"
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
