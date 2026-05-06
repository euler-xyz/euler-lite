<script setup lang="ts">
import type { AnyBorrowVaultPair } from '~/types/borrow-pair'
import type { SecuritizeCollateralVault, EVault, PortfolioBorrowPosition, VaultEntity } from '@eulerxyz/euler-v2-sdk'
import { getPairBorrowVault, getPairCollateralVault } from '~/utils/borrow-pair'

defineProps<{ pair: AnyBorrowVaultPair | PortfolioBorrowPosition<VaultEntity>, desktopOverview?: boolean, collateralVaults?: (EVault | SecuritizeCollateralVault)[] }>()
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
      :vault="getPairBorrowVault(pair)"
      :collateral-vaults="collateralVaults?.length ? collateralVaults : [getPairCollateralVault(pair)]"
    />
  </div>
</template>
