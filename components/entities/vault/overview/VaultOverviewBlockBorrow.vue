<script setup lang="ts">
import { formatNumber } from '~/utils/string-utils'
import { nanoToValue } from '~/utils/crypto-utils'
import type { Vault, SecuritizeVault } from '~/entities/vault'
import { getCurrentLiquidationLTV, isLiquidationLTVRamping, getRampTimeRemaining } from '~/entities/vault'
import { useVaultRegistry } from '~/composables/useVaultRegistry'

const emits = defineEmits<{
  'vault-click': [address: string]
}>()
const { vault } = defineProps<{ vault: Vault }>()
const { get: registryGet } = useVaultRegistry()

const onCollateralClick = (address: string) => {
  emits('vault-click', address)
}

// Build collateral pairs from ALL collateralLTVs where currentLiquidationLTV > 0
// This includes collaterals that are ramping down (borrowLTV == 0 but currentLiquidationLTV > 0)
const allCollateralPairs = computed(() => {
  const pairs: Array<{
    collateral: Vault | SecuritizeVault
    borrowLTV: bigint
    liquidationLTV: bigint
    initialLiquidationLTV: bigint
    targetTimestamp: bigint
    rampDuration: bigint
  }> = []

  vault.collateralLTVs.forEach((ltv) => {
    // Check if current liquidation LTV > 0 (not yet fully ramped down)
    if (getCurrentLiquidationLTV(ltv) <= 0n) return

    const pairData = {
      borrowLTV: ltv.borrowLTV,
      liquidationLTV: ltv.liquidationLTV,
      initialLiquidationLTV: ltv.initialLiquidationLTV,
      targetTimestamp: ltv.targetTimestamp,
      rampDuration: ltv.rampDuration,
    }

    // Try to find the collateral vault from registry
    const collateralEntry = registryGet(ltv.collateral)
    if (collateralEntry) {
      pairs.push({ collateral: collateralEntry.vault as Vault | SecuritizeVault, ...pairData })
    }
  })

  // Sort by borrow LTV descending (highest first)
  return pairs.sort((a, b) => (b.borrowLTV > a.borrowLTV ? 1 : b.borrowLTV < a.borrowLTV ? -1 : 0))
})

// Helper to format time remaining
const formatTimeRemaining = (seconds: bigint): string => {
  const days = Number(seconds) / 86400
  if (days >= 1) {
    return `${Math.ceil(days)} day${Math.ceil(days) > 1 ? 's' : ''}`
  }
  const hours = Number(seconds) / 3600
  if (hours >= 1) {
    return `${Math.ceil(hours)} hour${Math.ceil(hours) > 1 ? 's' : ''}`
  }
  const minutes = Number(seconds) / 60
  return `${Math.ceil(minutes)} minute${Math.ceil(minutes) > 1 ? 's' : ''}`
}
</script>

<template>
  <div
    v-if="allCollateralPairs.length"
    class="flex flex-col gap-24 p-24 border-b border-line-default last:border-b-0"
  >
    <div>
      <p class="text-h3 text-content-primary mb-12">
        Collateral exposure
      </p>
      <p class="text-content-secondary">
        Deposits in this market can be borrowed.
        Please make sure you're comfortable accepting the collateral
        listed in the table below before depositing.
      </p>
    </div>

    <div class="flex flex-col gap-12">
      <div
        v-for="pair in allCollateralPairs"
        :key="pair.collateral.address"
        class="bg-surface rounded-xl text-content-primary block no-underline cursor-pointer hover:bg-card-hover transition-colors shadow-sm"
        @click="onCollateralClick(pair.collateral.address)"
      >
        <div
          class="px-16 pt-16 pb-12 border-b border-line-subtle"
        >
          <VaultLabelsAndAssets
            :vault="pair.collateral"
            :assets="[pair.collateral.asset]"
          />
        </div>
        <div class="flex flex-col gap-12 px-16 pt-12 pb-16">
          <VaultOverviewLabelValue
            label="Max LTV"
            orientation="horizontal"
            :value="`${formatNumber(nanoToValue(pair.borrowLTV, 2), 2)}%`"
          />
          <VaultOverviewLabelValue
            orientation="horizontal"
          >
            <template #label>
              <span class="flex items-center gap-4">
                Liquidation LTV
                <span
                  v-if="isLiquidationLTVRamping(pair)"
                  @click.stop.prevent
                >
                  <UiFootnote
                    title="LTV Ramping"
                    :text="`The Liquidation LTV for this collateral is currently being reduced. Target Liquidation LTV: ${formatNumber(nanoToValue(pair.liquidationLTV, 2), 2)}%. Time remaining: ${formatTimeRemaining(getRampTimeRemaining(pair))}.`"
                    class="[--ui-footnote-icon-color:var(--c-content-tertiary)]"
                  />
                </span>
              </span>
            </template>
            <div class="flex items-center gap-4">
              <SvgIcon
                v-if="isLiquidationLTVRamping(pair)"
                name="arrow-top-right"
                class="!w-14 !h-14 text-warning-500 shrink-0 rotate-180"
                title="Liquidation LTV ramping down"
              />
              <span>{{ `${formatNumber(nanoToValue(getCurrentLiquidationLTV(pair), 2), 2)}%` }}</span>
            </div>
          </VaultOverviewLabelValue>
        </div>
      </div>
    </div>
  </div>
</template>
