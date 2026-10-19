<script setup lang="ts">
import type { AnyBorrowVaultPair } from '~/types/borrow-pair'
import { isSecuritizeCollateralVault, type SecuritizeCollateralVault, type EVault, type PortfolioBorrowPosition, type VaultEntity } from '@eulerxyz/euler-v2-sdk'
import { getPairBorrowVault, getPairCollateralVault } from '~/utils/borrow-pair'

const props = defineProps<{ pair: AnyBorrowVaultPair | PortfolioBorrowPosition<VaultEntity>, desktopOverview?: boolean, collateralVaults?: (EVault | SecuritizeCollateralVault)[] }>()

const checkedVaults = computed(() => {
  const borrow = getPairBorrowVault(props.pair)
  const collateral = getPairCollateralVault(props.pair)
  const target = (vault: EVault) => ({ address: vault.address, symbol: vault.asset.symbol })
  return isSecuritizeCollateralVault(collateral) ? [target(borrow)] : [target(borrow), target(collateral)]
})
</script>

<template>
  <div
    class="flex flex-col"
    :class="[desktopOverview ? 'gap-16' : 'gap-12']"
  >
    <VaultOverviewPairBlockGeneral
      :pair="pair"
      :default-open="true"
    />
    <VaultOverviewPairBlockTypes
      :pair="pair"
      :default-open="false"
    />
    <!-- Oracle adapters should always come from the liability (borrow) vault -->
    <VaultOverviewBlockOracleAdapters
      :vault="getPairBorrowVault(pair)"
      :collateral-vaults="collateralVaults?.length ? collateralVaults : [getPairCollateralVault(pair)]"
      :default-open="false"
    />
    <VaultOverviewBlockVaultChecks
      :vaults="checkedVaults"
      :default-open="false"
    />
    <VaultPairEntityDisclosures :pair="pair" />
  </div>
</template>
