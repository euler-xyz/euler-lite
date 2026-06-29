<script setup lang="ts">
import type { SecuritizeCollateralVault, EVaultCollateral, EVault } from '@eulerxyz/euler-v2-sdk'
import { getCollateralExposureGroups, getCollateralExposurePairs } from '~/utils/vault/collateral-exposure'
import { useVaultRegistry } from '~/composables/useVaultRegistry'
import { logWarn } from '~/utils/errorHandling'
import { VaultRampDownModal } from '#components'
import { compactNumber, formatCompactUsdValue, formatNumber } from '~/utils/string-utils'

const emits = defineEmits<{
  'vault-click': [address: string]
}>()
const { vault, defaultOpen = true } = defineProps<{ vault: EVault, defaultOpen?: boolean }>()
const { get: registryGet } = useVaultRegistry()
const {
  load: loadOpenInterest,
  getOpenInterestForVault,
  hasError: hasOpenInterestError,
  isLoaded: isOpenInterestLoaded,
} = useCollateralOpenInterest()
const isExpanded = ref(false)
const COLLAPSED_GROUP_COUNT = 3

const onCollateralClick = (address: string) => {
  emits('vault-click', address)
}

const getRampDownModalData = (ltv: EVaultCollateral) => ({
  props: ltv,
})

// Module-scope dedupe so we warn at most once per (vault, missing-collateral)
// pair across recomputes and SFC instances. Mirrors the dedupe in
// composables/useMarketGroups.ts so a curator can spot the same gap reported
// by either site without one suppressing the other.
const warnedUnresolved = new Set<string>()

const allCollateralPairs = computed(() =>
  getCollateralExposurePairs(
    vault,
    (addr) => {
      const entry = registryGet(addr)
      if (!entry?.vault) {
        const key = `${vault.address.toLowerCase()}:${addr.toLowerCase()}`
        if (!warnedUnresolved.has(key)) {
          warnedUnresolved.add(key)
          logWarn(
            'vault-overview/missing-collateral',
            `EVault ${vault.address} references unresolved collateral ${addr}`,
          )
        }
      }
      return entry?.vault as EVault | SecuritizeCollateralVault | undefined
    },
  ),
)

const openInterestUsdByCollateral = computed(() => getOpenInterestForVault(vault.address))
const collateralGroups = computed(() =>
  getCollateralExposureGroups(allCollateralPairs.value, openInterestUsdByCollateral.value),
)
const totalOpenInterestUsd = computed(() =>
  collateralGroups.value.reduce((sum, group) => sum + group.openInterestUsd, 0),
)
const visibleCollateralGroups = computed(() =>
  isExpanded.value ? collateralGroups.value : collateralGroups.value.slice(0, COLLAPSED_GROUP_COUNT),
)
const visibleCollateralPairs = computed(() =>
  visibleCollateralGroups.value.flatMap(group => group.items),
)
const hiddenCollateralPairCount = computed(() =>
  collateralGroups.value
    .slice(visibleCollateralGroups.value.length)
    .reduce((count, group) => count + group.items.length, 0),
)
const getPairOpenInterestUsd = (pair: { collateral: EVault | SecuritizeCollateralVault }) => {
  const entry = Object.entries(openInterestUsdByCollateral.value)
    .find(([address]) => address.toLowerCase() === pair.collateral.address.toLowerCase())
  return entry?.[1] ?? 0
}
const hasLiveExposureData = computed(() => isOpenInterestLoaded.value && !hasOpenInterestError.value)
const formatExposurePercent = (valueUsd: number) =>
  !hasLiveExposureData.value
    ? '-'
    : totalOpenInterestUsd.value > 0 ? `${compactNumber(valueUsd / totalOpenInterestUsd.value * 100, 1, 0)}%` : '0%'
const formatLiveExposureUsd = (valueUsd: number) =>
  hasLiveExposureData.value ? formatCompactUsdValue(valueUsd) : '-'
const toggleExpanded = () => {
  isExpanded.value = !isExpanded.value
}

watchEffect(() => {
  if (!vault.address) return
  void loadOpenInterest()
})
</script>

<template>
  <VaultOverviewAccordionSection
    v-if="collateralGroups.length"
    title="Collateral exposure"
    :default-open="defaultOpen"
    content-class="flex flex-col gap-24"
  >
    <div>
      <p class="text-content-secondary">
        Deposits in this vault can be borrowed.
        Review live borrow exposure and configured collateral vaults before supplying.
      </p>
    </div>

    <div class="flex flex-col gap-12">
      <div
        v-for="pair in visibleCollateralPairs"
        :key="pair.collateral.address"
        class="cursor-pointer rounded-12 border border-line-subtle bg-surface p-16 shadow-sm transition-colors hover:bg-card-hover"
        @click="onCollateralClick(pair.collateral.address)"
      >
        <VaultLabelsAndAssets
          :vault="pair.collateral"
          :assets="[pair.collateral.asset]"
        />
        <div class="mt-12 grid grid-cols-1 gap-12">
          <VaultOverviewLabelValue
            label="Live exposure"
            orientation="horizontal"
          >
            <span class="flex items-center gap-4">
              {{ formatLiveExposureUsd(getPairOpenInterestUsd(pair)) }}
              <span class="text-content-secondary">({{ formatExposurePercent(getPairOpenInterestUsd(pair)) }})</span>
            </span>
          </VaultOverviewLabelValue>
          <VaultOverviewLabelValue
            label="Max LTV"
            orientation="horizontal"
            :value="`${formatNumber(ltvToPercent(pair.ltv.borrowLTV), 2)}%`"
          />
          <VaultOverviewLabelValue
            orientation="horizontal"
          >
            <template #label>
              <span class="flex items-center gap-4">
                Liquidation LTV
                <UiModalPreviewTrigger
                  v-if="pair.ltv.isLiquidationLTVRamping"
                  :component="VaultRampDownModal"
                  :modal-data="() => getRampDownModalData(pair.ltv)"
                  aria-label="Show liquidation LTV ramp-down details"
                >
                  <SvgIcon
                    class="!w-20 !h-20 text-content-muted cursor-pointer hover:text-content-secondary"
                    name="info-circle"
                  />
                </UiModalPreviewTrigger>
              </span>
            </template>
            <span class="flex items-center gap-4">
              <UiModalPreviewTrigger
                v-if="pair.ltv.isLiquidationLTVRamping"
                :component="VaultRampDownModal"
                :modal-data="() => getRampDownModalData(pair.ltv)"
                aria-label="Show liquidation LTV ramp-down details"
              >
                <SvgIcon
                  name="arrow-top-right"
                  class="!w-14 !h-14 text-warning-500 shrink-0 rotate-180 cursor-pointer"
                />
              </UiModalPreviewTrigger>
              {{ `${formatNumber(ltvToPercent(pair.ltv.currentLiquidationLTV), 2)}%` }}
            </span>
          </VaultOverviewLabelValue>
        </div>
      </div>

      <button
        v-if="collateralGroups.length > COLLAPSED_GROUP_COUNT"
        type="button"
        class="self-center text-p4 font-medium text-content-accent transition-colors hover:text-accent-600"
        @click="toggleExpanded"
      >
        {{ isExpanded ? 'Show less' : `Show more (${hiddenCollateralPairCount})` }}
      </button>
    </div>
  </VaultOverviewAccordionSection>
</template>
