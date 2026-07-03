<script setup lang="ts">
import type { SecuritizeCollateralVault, EVault } from '@eulerxyz/euler-v2-sdk'
import { useVaultRegistry } from '~/composables/useVaultRegistry'
import { compactNumber, formatCompactUsdValue, formatNumber } from '~/utils/string-utils'
import { getCollateralExposureGroups, getCollateralExposurePairs } from '~/utils/vault/collateral-exposure'

const emits = defineEmits(['close'])
const router = useRouter()
const route = useRoute()
const { vault } = defineProps<{ vault: EVault }>()
const { get: registryGet } = useVaultRegistry()
const {
  load: loadOpenInterest,
  getOpenInterestForVault,
  hasError: hasOpenInterestError,
  isLoaded: isOpenInterestLoaded,
  isOpenInterestEnabled,
} = useCollateralOpenInterest()

const allCollateralPairs = computed(() =>
  getCollateralExposurePairs(
    vault,
    addr => registryGet(addr)?.vault as EVault | SecuritizeCollateralVault | undefined,
  ),
)

const openInterestUsdByCollateral = computed<Record<string, number>>(() =>
  isOpenInterestEnabled.value ? getOpenInterestForVault(vault.address) : {},
)
const collateralGroups = computed(() =>
  getCollateralExposureGroups(allCollateralPairs.value, openInterestUsdByCollateral.value),
)
const collateralPairs = computed(() => collateralGroups.value.flatMap(group => group.items))
const totalOpenInterestUsd = computed(() =>
  collateralGroups.value.reduce((sum, group) => sum + group.openInterestUsd, 0),
)
const getPairOpenInterestUsd = (pair: { collateral: EVault | SecuritizeCollateralVault }) => {
  const entry = Object.entries(openInterestUsdByCollateral.value)
    .find(([address]) => address.toLowerCase() === pair.collateral.address.toLowerCase())
  return entry?.[1] ?? 0
}
const hasLiveExposureData = computed(() =>
  isOpenInterestEnabled.value && isOpenInterestLoaded.value && !hasOpenInterestError.value,
)
const modalTitle = computed(() =>
  isOpenInterestEnabled.value ? 'Exposure' : 'Collateral exposure',
)
const description = computed(() =>
  isOpenInterestEnabled.value
    ? 'Make sure you\'re comfortable with the live exposure assets and configured collateral vaults before supplying.'
    : 'Make sure you\'re comfortable with the configured collateral vaults and LTVs before supplying.',
)
const formatExposurePercent = (valueUsd: number) =>
  !hasLiveExposureData.value
    ? '-'
    : totalOpenInterestUsd.value > 0 ? `${compactNumber(valueUsd / totalOpenInterestUsd.value * 100, 1, 0)}%` : '0%'
const formatLiveExposureUsd = (valueUsd: number) =>
  hasLiveExposureData.value ? formatCompactUsdValue(valueUsd) : '-'

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

watchEffect(() => {
  if (!vault.address || !isOpenInterestEnabled.value) return
  void loadOpenInterest()
})
</script>

<template>
  <BaseModalWrapper
    :title="modalTitle"
    @close="$emit('close')"
  >
    <div
      v-if="collateralGroups.length > 0"
      class="flex flex-col gap-12"
    >
      <p class="text-p3 text-content-secondary mb-4">
        Deposits in this vault can be borrowed.
        {{ description }}
      </p>
      <div
        v-for="pair in collateralPairs"
        :key="pair.collateral.address"
        class="cursor-pointer rounded-12 border border-line-subtle bg-surface p-16 text-content-primary transition-colors hover:bg-card-hover"
        @click="onCollateralClick(pair.collateral.address)"
      >
        <div class="min-w-0">
          <VaultLabelsAndAssets
            class="min-w-0"
            :vault="pair.collateral"
            :assets="[pair.collateral.asset]"
          />
          <VaultTypeBadges
            class="mt-8 w-full justify-end"
            :vault="pair.collateral"
            summary-only
            @click.stop.prevent
          />
        </div>
        <div class="flex flex-col gap-12 pt-12">
          <VaultOverviewLabelValue
            v-if="isOpenInterestEnabled"
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
          <VaultOverviewLabelValue orientation="horizontal">
            <template #label>
              <span class="flex items-center gap-4">
                Liquidation LTV
                <span
                  v-if="pair.ltv.isLiquidationLTVRamping"
                  @click.stop.prevent
                >
                  <UiHoverPreviewTooltip
                    title="LTV Ramping"
                    :text="`The Liquidation LTV for this collateral is currently being reduced. Target Liquidation LTV: ${formatNumber(ltvToPercent(pair.ltv.liquidationLTV), 2)}%. Time remaining: ${formatTimeRemaining(pair.ltv.rampTimeRemaining)}.`"
                  />
                </span>
              </span>
            </template>
            <div class="flex items-center gap-4">
              <UiHoverPreviewTooltip
                v-if="pair.ltv.isLiquidationLTVRamping"
                title="Liquidation LTV ramping down"
                text="The Liquidation LTV for this collateral is currently being reduced."
                placement="top-start"
              >
                <SvgIcon
                  name="arrow-top-right"
                  class="!w-14 !h-14 text-warning-500 shrink-0 rotate-180"
                />
              </UiHoverPreviewTooltip>
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
