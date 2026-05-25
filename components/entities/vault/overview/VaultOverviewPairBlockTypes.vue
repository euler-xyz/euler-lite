<script setup lang="ts">
import type { AnyBorrowVaultPair } from '~/types/borrow-pair'
import type { PortfolioBorrowPosition, VaultEntity } from '@eulerxyz/euler-v2-sdk'
import { getPairBorrowVault, getPairCollateralVault } from '~/utils/borrow-pair'

const { pair } = defineProps<{ pair: AnyBorrowVaultPair | PortfolioBorrowPosition<VaultEntity> }>()

const collateralVault = computed(() => getPairCollateralVault(pair))
const borrowVault = computed(() => getPairBorrowVault(pair))
const collateralBadges = useVaultTypeBadges(collateralVault)
const borrowBadges = useVaultTypeBadges(borrowVault)

const showVaultTypesSummary = computed(() =>
  collateralBadges.hasSummaryBadges.value || borrowBadges.hasSummaryBadges.value,
)
</script>

<template>
  <div
    v-if="showVaultTypesSummary"
    class="bg-surface-secondary rounded-xl flex flex-col gap-24 p-24 shadow-card"
  >
    <p class="text-h3 text-content-primary">
      Vault types
    </p>
    <div class="grid grid-cols-[1fr_1px_1fr] gap-20 items-stretch">
      <div class="min-w-0 flex flex-col gap-12">
        <div class="flex items-center gap-8 min-w-0 pl-2">
          <AssetAvatar
            :asset="collateralVault.asset"
            size="20"
          />
          <span class="text-[14px] leading-none font-semibold text-content-primary truncate">
            {{ collateralVault.asset.symbol }}
          </span>
        </div>
        <VaultTypeBadges
          :vault="collateralVault"
          layout="stacked"
          size="large"
          summary-only
        />
      </div>

      <div class="vault-types-divider w-[1px]" />

      <div class="min-w-0 flex flex-col gap-12">
        <div class="flex items-center gap-8 min-w-0 pl-2">
          <AssetAvatar
            :asset="borrowVault.asset"
            size="20"
          />
          <span class="text-[14px] leading-none font-semibold text-content-primary truncate">
            {{ borrowVault.asset.symbol }}
          </span>
        </div>
        <VaultTypeBadges
          :vault="borrowVault"
          layout="stacked"
          size="large"
          summary-only
        />
      </div>
    </div>
  </div>
</template>

<style scoped lang="scss">
.vault-types-divider {
  background-color: rgba(0, 0, 0, 0.04);

  [data-theme="dark"] & {
    background-color: rgba(255, 255, 255, 0.04);
  }
}
</style>
