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
      :default-open="true"
    />

    <VaultOverviewEarnBlockStats
      :vault="vault"
      :default-open="true"
    />

    <VaultOverviewEarnBlockExposure
      :vault="vault"
      :default-open="false"
      @vault-click="(address: string) => emits('vault-click', address)"
    />

    <VaultOverviewEarnBlockManagement
      :vault="vault"
      :default-open="false"
    />

    <VaultOverviewEarnBlockAddresses
      :vault="vault"
      :default-open="false"
    />
  </div>
</template>
