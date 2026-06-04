<script setup lang="ts">
import type { AnyBorrowVaultPair } from '~/types/borrow-pair'
import type { SecuritizeCollateralVault, EVault, PortfolioBorrowPosition, VaultEntity } from '@eulerxyz/euler-v2-sdk'
import { getPairBorrowVault, getPairCollateralVault } from '~/utils/borrow-pair'
import { vaultOverviewPairOverviewKey } from '~/composables/useVaultOverviewPairOverview'

const props = defineProps<{
  pair: AnyBorrowVaultPair | PortfolioBorrowPosition<VaultEntity>
  desktopOverview?: boolean
  collateralVaults?: (EVault | SecuritizeCollateralVault)[]
}>()

const overview = useVaultOverviewPairOverview(() => props.pair)
provide(vaultOverviewPairOverviewKey, overview)

const { showMultiplySection } = overview
</script>

<template>
  <div
    class="flex flex-col"
    :class="[desktopOverview ? 'gap-16' : 'gap-12']"
  >
    <VaultOverviewPairBlockGeneral />
    <VaultOverviewPairBlockBorrow />
    <VaultOverviewPairBlockMultiply
      v-if="showMultiplySection"
    />
    <VaultOverviewPairBlockTypes
      :pair="pair"
    />
    <!-- Oracle adapters should always come from the liability (borrow) vault -->
    <VaultOverviewBlockOracleAdapters
      :vault="getPairBorrowVault(pair)"
      :collateral-vaults="collateralVaults?.length ? collateralVaults : [getPairCollateralVault(pair)]"
    />
  </div>
</template>
