<script setup lang="ts">
import type { Vault } from '~/entities/vault'

const emits = defineEmits<{
  'vault-click': [address: string]
}>()
const { vault } = defineProps<{ vault: Vault, desktopOverview?: boolean }>()
</script>

<template>
  <div
    class="flex flex-col"
  >
    <VaultOverviewBlockGeneral
      :vault="vault"
    />

    <VaultOverviewBlockStats
      :vault="vault"
    />

    <VaultOverviewBlockRiskParameters
      :vault="vault"
    />

    <VaultOverviewBlockBorrow
      :vault="vault"
      @vault-click="(address: string) => emits('vault-click', address)"
    />

    <LazyVaultOverviewBlockIRM
      :vault="vault"
    />

    <VaultOverviewBlockAddresses
      :vault="vault"
    />
  </div>
</template>
