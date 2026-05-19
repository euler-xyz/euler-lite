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
    <div class="flex flex-col gap-12">
      <div class="w-full rounded-xl bg-surface p-16 flex flex-col gap-12 border border-line-subtle">
        <div class="flex items-center justify-between gap-8">
          <div class="flex items-center gap-8 min-w-0">
            <AssetAvatar
              :asset="pair.collateral.asset"
              size="20"
            />
            <span class="text-p2 font-semibold text-content-primary truncate">
              {{ pair.collateral.asset.symbol }}
            </span>
          </div>
          <span class="text-p4 text-content-tertiary uppercase tracking-wide flex-shrink-0">
            Collateral
          </span>
        </div>
        <VaultTypeBadges :vault="pair.collateral" />
      </div>

      <div class="w-full rounded-xl bg-surface p-16 flex flex-col gap-12 border border-line-subtle">
        <div class="flex items-center justify-between gap-8">
          <div class="flex items-center gap-8 min-w-0">
            <AssetAvatar
              :asset="pair.borrow.asset"
              size="20"
            />
            <span class="text-p2 font-semibold text-content-primary truncate">
              {{ pair.borrow.asset.symbol }}
            </span>
          </div>
          <span class="text-p4 text-content-tertiary uppercase tracking-wide flex-shrink-0">
            Borrow
          </span>
        </div>
        <VaultTypeBadges :vault="pair.borrow" />
      </div>
    </div>
  </div>
</template>
