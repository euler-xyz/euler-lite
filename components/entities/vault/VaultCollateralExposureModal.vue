<script setup lang="ts">
import type { SecuritizeCollateralVault, EVaultCollateral, EVault } from '@eulerxyz/euler-v2-sdk'
import { useVaultRegistry } from '~/composables/useVaultRegistry'
import { formatNumber } from '~/utils/string-utils'

const emits = defineEmits(['close'])
const router = useRouter()
const route = useRoute()
const { vault } = defineProps<{ vault: EVault }>()
const { get: registryGet } = useVaultRegistry()

const allCollateralPairs = computed(() => {
  const pairs: Array<{
    collateral: EVault | SecuritizeCollateralVault
    ltv: EVaultCollateral
  }> = []

  vault.collaterals.forEach((ltv) => {
    if (ltv.currentLiquidationLTV <= 0) return

    const collateralEntry = registryGet(ltv.address)
    if (collateralEntry) {
      pairs.push({ collateral: collateralEntry.vault as EVault | SecuritizeCollateralVault, ltv })
    }
  })

  return pairs.sort((a, b) => (b.ltv.borrowLTV > a.ltv.borrowLTV ? 1 : b.ltv.borrowLTV < a.ltv.borrowLTV ? -1 : 0))
})

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

const onCollateralClick = (address: string) => {
  emits('close')
  router.push({ path: `/borrow/${address}/${vault.address}`, query: { network: route.query.network } })
}
</script>

<template>
  <BaseModalWrapper
    title="Collateral exposure"
    @close="$emit('close')"
  >
    <div
      v-if="allCollateralPairs.length > 0"
      class="flex flex-col gap-12"
    >
      <p class="text-p3 text-content-secondary mb-4">
        Deposits in this vault can be borrowed.
        Make sure you're comfortable accepting the collaterals listed below before supplying.
      </p>
      <div
        v-for="pair in allCollateralPairs"
        :key="pair.collateral.address"
        class="bg-surface rounded-12 text-content-primary block no-underline cursor-pointer hover:bg-card-hover transition-colors"
        @click="onCollateralClick(pair.collateral.address)"
      >
        <div class="px-16 pt-16 pb-12 border-b border-line-subtle">
          <VaultLabelsAndAssets
            :vault="pair.collateral"
            :assets="[pair.collateral.asset]"
          />
        </div>
        <div class="flex flex-col gap-12 px-16 pt-12 pb-16">
          <VaultOverviewLabelValue
            label="Max LTV"
            orientation="horizontal"
            :value="`${formatNumber(ltvToPercent(pair.ltv.borrowLTV), 2)}%`"
          />
          <VaultOverviewLabelValue orientation="horizontal">
            <template #label>
              <span class="flex items-center gap-4">
                Liquidation LTV
                <span
                  v-if="pair.ltv.isLiquidationLTVRamping"
                  @click.stop.prevent
                >
                  <UiFootnote
                    title="LTV Ramping"
                    :text="`The Liquidation LTV for this collateral is currently being reduced. Target Liquidation LTV: ${formatNumber(ltvToPercent(pair.ltv.liquidationLTV), 2)}%. Time remaining: ${formatTimeRemaining(pair.ltv.rampTimeRemaining)}.`"
                    class="[--ui-footnote-icon-color:var(--c-content-tertiary)]"
                  />
                </span>
              </span>
            </template>
            <div class="flex items-center gap-4">
              <SvgIcon
                v-if="pair.ltv.isLiquidationLTVRamping"
                name="arrow-top-right"
                class="!w-14 !h-14 text-warning-500 shrink-0 rotate-180"
                title="Liquidation LTV ramping down"
              />
              <span>{{ `${formatNumber(ltvToPercent(pair.ltv.currentLiquidationLTV), 2)}%` }}</span>
            </div>
          </VaultOverviewLabelValue>
        </div>
      </div>
    </div>
    <div
      v-else
      class="py-24 text-center text-content-secondary"
    >
      No active collateral for this vault.
    </div>
  </BaseModalWrapper>
</template>
