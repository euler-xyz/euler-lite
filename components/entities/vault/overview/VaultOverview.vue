<script setup lang="ts">
import type { EVault } from '@eulerxyz/euler-v2-sdk'
import { isVaultCyclicalNote } from '~/utils/eulerLabelsUtils'

const emits = defineEmits<{
  'vault-click': [address: string]
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
      :default-open="true"
    />

    <VaultOverviewBlockStats
      :vault="vault"
      :default-open="true"
    />

    <VaultOverviewBlockRiskParameters
      :vault="vault"
      :default-open="false"
    />

    <VaultOverviewBlockBorrow
      :vault="vault"
      :default-open="false"
      @vault-click="(address: string) => emits('vault-click', address)"
    />

    <LazyVaultOverviewBlockCyclicalIRM
      v-if="isCyclicalIRM"
      :vault="vault"
      :default-open="false"
    />
    <LazyVaultOverviewBlockIRM
      v-else
      :vault="vault"
      :default-open="false"
    />

    <VaultOverviewBlockAddresses
      :vault="vault"
      :default-open="false"
    />
  </div>
</template>
