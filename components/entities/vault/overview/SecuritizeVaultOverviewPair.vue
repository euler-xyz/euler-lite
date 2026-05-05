<script setup lang="ts">
import type { SecuritizeBorrowVaultPair, EVault } from '~/entities/vault'

defineProps<{ pair: SecuritizeBorrowVaultPair, desktopOverview?: boolean }>()
</script>

<template>
  <div
    class="flex flex-col"
    :class="[!desktopOverview ? 'gap-12' : '']"
  >
    <SecuritizeVaultOverviewPairBlockGeneral
      :pair="pair"
      :class="[desktopOverview ? 'py-16 [&:first-child]:!pt-0 px-0' : '']"
    />
    <!-- Oracle adapters should always come from the liability (borrow) vault -->
    <VaultOverviewBlockOracleAdapters
      :vault="pair.borrow"
      :collateral-vaults="[pair.collateral as unknown as EVault]"
      :class="[desktopOverview ? 'py-16 [&:first-child]:!pt-0 px-0' : '']"
    />
  </div>
</template>
