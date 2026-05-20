<script setup lang="ts">
import type { AnyBorrowVaultPair } from '~/entities/vault'
import type { AccountBorrowPosition } from '~/entities/account'

defineProps<{ pair: AnyBorrowVaultPair | AccountBorrowPosition }>()
</script>

<template>
  <div class="bg-surface-secondary rounded-xl flex flex-col gap-24 p-24 shadow-card">
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
          :vault="pair.collateral"
          layout="stacked"
          size="large"
        />
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
          :vault="pair.borrow"
          layout="stacked"
          size="large"
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
