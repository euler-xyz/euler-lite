<script setup lang="ts">
import type { AnyBorrowVaultPair, SecuritizeCollateralVault, EVault } from '~/entities/vault'
import type { AccountBorrowPosition } from '~/entities/account'

defineProps<{ pair: AnyBorrowVaultPair | AccountBorrowPosition, desktopOverview?: boolean, collateralVaults?: (EVault | SecuritizeCollateralVault)[] }>()
</script>

<template>
  <div
    class="flex flex-col"
    :class="[desktopOverview ? 'gap-16' : 'gap-12']"
  >
    <VaultOverviewPairBlockGeneral
      :pair="pair"
    />
    <!-- Oracle adapters should always come from the liability (borrow) vault -->
    <VaultOverviewBlockOracleAdapters
      :vault="pair.borrow"
      :collateral-vaults="collateralVaults?.length ? collateralVaults : [pair.collateral]"
    />
  </div>
</template>
