<script setup lang="ts">
import type { SecuritizeBorrowVaultPair } from '~/types/borrow-pair'
import type { EVault } from '@eulerxyz/euler-v2-sdk'

defineProps<{ pair: SecuritizeBorrowVaultPair, desktopOverview?: boolean }>()
</script>

<template>
  <div
    class="flex flex-col"
    :class="[desktopOverview ? 'gap-16' : 'gap-12']"
  >
    <SecuritizeVaultOverviewPairBlockGeneral
      :pair="pair"
      :default-open="true"
    />
    <!-- Oracle adapters should always come from the liability (borrow) vault -->
    <VaultOverviewBlockOracleAdapters
      :vault="pair.borrow"
      :collateral-vaults="[pair.collateral as unknown as EVault]"
      :default-open="false"
    />
  </div>
</template>
