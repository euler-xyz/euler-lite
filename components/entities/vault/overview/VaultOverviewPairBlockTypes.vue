<script setup lang="ts">
import type { AnyBorrowVaultPair } from '~/entities/vault'
import type { AccountBorrowPosition } from '~/entities/account'

const { pair } = defineProps<{ pair: AnyBorrowVaultPair | AccountBorrowPosition }>()

const collateral = computed(() => pair.collateral)
const borrow = computed(() => pair.borrow)
const collateralBadges = useVaultTypeBadges(collateral)
const borrowBadges = useVaultTypeBadges(borrow)
const hasCollateralSummaryBadges = computed(() => collateralBadges.hasSummaryBadges.value)
const hasBorrowSummaryBadges = computed(() => borrowBadges.hasSummaryBadges.value)

const showVaultTypesSummary = computed(() =>
  hasCollateralSummaryBadges.value || hasBorrowSummaryBadges.value,
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
            :asset="pair.collateral.asset"
            size="20"
          />
          <span class="text-[14px] leading-none font-semibold text-content-primary truncate">
            {{ pair.collateral.asset.symbol }}
          </span>
        </div>
        <VaultTypeBadges
          v-if="hasCollateralSummaryBadges"
          :vault="pair.collateral"
          layout="stacked"
          size="large"
          summary-only
        />
        <div
          v-else
          class="vault-types-empty"
        >
          <SvgIcon
            name="check-circle"
            class="vault-types-empty__icon"
          />
          <span>Standard vault</span>
        </div>
      </div>

      <div class="vault-types-divider w-[1px]" />

      <div class="min-w-0 flex flex-col gap-12">
        <div class="flex items-center gap-8 min-w-0 pl-2">
          <AssetAvatar
            :asset="pair.borrow.asset"
            size="20"
          />
          <span class="text-[14px] leading-none font-semibold text-content-primary truncate">
            {{ pair.borrow.asset.symbol }}
          </span>
        </div>
        <VaultTypeBadges
          v-if="hasBorrowSummaryBadges"
          :vault="pair.borrow"
          layout="stacked"
          size="large"
          summary-only
        />
        <div
          v-else
          class="vault-types-empty"
        >
          <SvgIcon
            name="check-circle"
            class="vault-types-empty__icon"
          />
          <span>Standard vault</span>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped lang="scss">
.vault-types-empty {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  max-width: 100%;
  min-height: 48px;
  padding: 12px 15px;
  border: 1px solid var(--border-default);
  border-radius: 10px;
  color: var(--text-secondary);
  font-size: 14.5px;
  font-weight: 500;
  line-height: 1.2;
  background-color: rgba(255, 255, 255, 0.035);

  [data-theme="light"] & {
    background-color: rgba(0, 0, 0, 0.025);
  }
}

.vault-types-empty__icon {
  width: 16px;
  height: 16px;
  flex-shrink: 0;
}

.vault-types-divider {
  background-color: rgba(0, 0, 0, 0.04);

  [data-theme="dark"] & {
    background-color: rgba(255, 255, 255, 0.04);
  }
}
</style>
