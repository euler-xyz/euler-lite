<script setup lang="ts">
import type { EVault } from '@eulerxyz/euler-v2-sdk'
import { isVaultCyclicalNote } from '~/utils/eulerLabelsUtils'

const emits = defineEmits<{
  'vault-click': [address: string]
  'market-click': []
}>()
const { vault } = defineProps<{ vault: EVault, desktopOverview?: boolean }>()

const isCyclicalIRM = computed(() => isVaultCyclicalNote(vault.address))
</script>

<template>
  <div
    class="flex flex-col"
    :class="[desktopOverview ? 'gap-16' : 'gap-12']"
  >
    <VaultOverviewBlockGeneral
      :vault="vault"
      @market-click="emits('market-click')"
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

    <LazyVaultOverviewBlockCyclicalIRM
      v-if="isCyclicalIRM"
      :vault="vault"
    />
    <LazyVaultOverviewBlockIRM
      v-else
      :vault="vault"
    />

    <VaultOverviewBlockAddresses
      :vault="vault"
    />
  </div>
</template>
