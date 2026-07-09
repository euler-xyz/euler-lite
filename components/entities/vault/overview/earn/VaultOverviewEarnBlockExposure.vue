<script setup lang="ts">
import { isEVault, type EVault, type EulerEarnStrategyInfo, type EulerEarn, type SecuritizeCollateralVault } from '@eulerxyz/euler-v2-sdk'
import { useVaultRegistry } from '~/composables/useVaultRegistry'
import { formatNumber, compactNumber, formatCompactUsdValue, formatExactAmount } from '~/utils/string-utils'
import { nanoToValue, roundAndCompactTokens } from '~/utils/crypto-utils'
import { withVaultIntrinsicApy, getVaultIntrinsicApy, getVaultIntrinsicApyInfo } from '~/utils/vault-intrinsic-apy'
import { VaultApyModal, UiModalPreviewTrigger } from '#components'
import { getStrategyHookWarning } from '~/composables/useVaultWarnings'
import { DateTime } from 'luxon'
import { getAddress } from 'viem'
import { logWarn } from '~/utils/errorHandling'
import { getAssetUsdValue } from '~/utils/sdk-prices'
import {
  getCollateralExposureGroups,
  getCollateralExposurePairs,
  type CollateralExposureGroup,
} from '~/utils/vault/collateral-exposure'
import {
  resolveVaultExposureDisplay,
  type ExposureValueState,
  type VaultExposureDisplay,
} from '~/utils/vault/exposure-display'

const emits = defineEmits<{
  'vault-click': [address: string]
}>()

const onExposureClick = (address: string) => {
  emits('vault-click', address)
}
const { vault, defaultOpen = true } = defineProps<{ vault: EulerEarn, defaultOpen?: boolean }>()

const { getOrFetch, get: registryGet } = useVaultRegistry()
const {
  load: loadOpenInterest,
  getOpenInterestForVault,
  hasError: hasOpenInterestError,
  isLoaded: isOpenInterestLoaded,
  isOpenInterestEnabled,
} = useCollateralOpenInterest()
const { isEscrowLoadedOnce, isMarketDataResolved } = useVaults()
const { settings } = useUserSettings()
const enableIntrinsicApy = computed(() => settings.value.enableIntrinsicApy)
const { getSupplyRewardApy, hasSupplyRewards, getSupplyRewardCampaigns } = useRewardsApy()

const exposureVaults: Ref<EVault[]> = ref([])
const isLoading = ref(false)
const exposureUsdPrices = ref<Map<string, number>>(new Map())
const unavailableExposureUsdPrices = ref<Set<string>>(new Set())
const exposureCapUsdPrices = ref<Map<string, number>>(new Map())
let priceLoadId = 0

const UINT136_MAX = 2n ** 136n - 1n

const isPendingRemoval = (strategy: EulerEarnStrategyInfo) => strategy.removableAt > 0

const isUnlimitedCap = (strategy: EulerEarnStrategyInfo) => strategy.allocationCap.current >= UINT136_MAX

const getPendingRemovalTooltipText = (strategy: EulerEarnStrategyInfo) => {
  const removableAt = DateTime.fromSeconds(Number(strategy.removableAt))
  return `This strategy is pending removal. Removable ${removableAt.toRelative({ base: DateTime.now(), style: 'short' })}.`
}

const exposureList = computed(() => {
  return [...vault.strategies].sort((a, b) => {
    return nanoToValue(b.allocatedAssets) - nanoToValue(a.allocatedAssets)
  })
})

const totalAllocatedAssets = computed(() => {
  return exposureList.value.reduce((prev, curr) => {
    return prev + curr.allocatedAssets
  }, 0n)
})

const load = async () => {
  try {
    isLoading.value = true
    // Wait for escrow vaults to load first, so they're properly identified in registry
    await until(isEscrowLoadedOnce).toBe(true)
    const promises = exposureList.value.map((exposure) => {
      return exposure.vault ?? getOrFetch(exposure.address) as Promise<EVault>
    })
    exposureVaults.value = (await Promise.all(promises)).filter((vlt): vlt is EVault => Boolean(vlt) && isEVault(vlt))

    // Load USD prices for all exposures
    await loadExposureUsdPrices()
  }
  catch (e) {
    logWarn('VaultOverviewEarnBlockExposure/loadExposure', e)
  }
  finally {
    isLoading.value = false
  }
}

const loadExposureUsdPrices = async () => {
  const loadId = ++priceLoadId
  const results = await Promise.all(exposureList.value.map(async (exposure) => {
    const exposureVault = getExposureVaultByAddress(exposure.address)
    if (!exposureVault) return null

    const [allocationUsd, capUsd] = await Promise.all([
      getAssetUsdValue(exposure.allocatedAssets, exposureVault, 'off-chain'),
      isUnlimitedCap(exposure)
        ? Promise.resolve(undefined)
        : getAssetUsdValue(exposure.allocationCap.current, exposureVault, 'off-chain'),
    ])

    return { exposure, allocationUsd, capUsd }
  }))
  if (loadId !== priceLoadId) return

  const newPrices = new Map<string, number>()
  const newUnavailablePrices = new Set<string>()
  const newCapPrices = new Map<string, number>()
  results.forEach((result) => {
    if (!result) return

    const { exposure, allocationUsd, capUsd } = result
    if (allocationUsd !== undefined) {
      newPrices.set(exposure.address.toLowerCase(), allocationUsd)
    }
    else {
      newUnavailablePrices.add(exposure.address.toLowerCase())
    }
    if (!isUnlimitedCap(exposure) && capUsd !== undefined) {
      newCapPrices.set(exposure.address.toLowerCase(), capUsd)
    }
  })
  exposureUsdPrices.value = newPrices
  unavailableExposureUsdPrices.value = newUnavailablePrices
  exposureCapUsdPrices.value = newCapPrices
}

const getExposureVaultByAddress = (address: string) => {
  const normalized = getAddress(address)
  return exposureVaults.value.find(vlt => normalized === getAddress(vlt.address))
}

const exposureRows = computed(() => {
  return exposureList.value.map((exposure) => {
    const strategyVault = exposure.vault && isEVault(exposure.vault)
      ? exposure.vault as EVault
      : getExposureVaultByAddress(exposure.address)
    return {
      exposure,
      vault: strategyVault,
      hookWarning: strategyVault ? getStrategyHookWarning(strategyVault) : null,
    }
  })
})

const getStrategyCollateralGroups = (strategyVault: EVault | undefined): CollateralExposureGroup[] => {
  if (!strategyVault) return []

  return getCollateralExposureGroups(
    getCollateralExposurePairs(
      strategyVault,
      addr => registryGet(addr)?.vault as EVault | SecuritizeCollateralVault | undefined,
    ),
    getOpenInterestForVault(strategyVault.address),
  )
}

const collateralExposureGroupsByStrategy = computed(() => {
  const groupsByStrategy = new Map<string, CollateralExposureGroup[]>()
  for (const row of exposureRows.value) {
    if (!row.vault) continue
    groupsByStrategy.set(getAddress(row.vault.address), getStrategyCollateralGroups(row.vault))
  }
  return groupsByStrategy
})

// Per-strategy exposure display. Mirrors the lend/earn cards: when open interest
// isn't available for the chain (or errors / returns no rows) it degrades to the
// RPC-derived fallback instead of hiding, so the row stays populated on chains
// pinned to on-chain reads. `totalSupplyState` tracks the strategy's allocation
// price: ready once priced, unavailable when the price is missing, loading until
// the price load resolves.
const strategyExposureDisplayByAddress = computed(() => {
  const result = new Map<string, VaultExposureDisplay>()
  for (const row of exposureRows.value) {
    const strategyVault = row.vault
    if (!strategyVault) continue

    const key = strategyVault.address.toLowerCase()
    const totalSupplyState: ExposureValueState = exposureUsdPrices.value.has(key)
      ? 'ready'
      : unavailableExposureUsdPrices.value.has(key) ? 'unavailable' : 'loading'

    result.set(key, resolveVaultExposureDisplay({
      openInterestEnabled: isOpenInterestEnabled.value,
      openInterestLoaded: isOpenInterestLoaded.value,
      hasOpenInterestError: hasOpenInterestError.value,
      getCollateralGroups: () => collateralExposureGroupsByStrategy.value.get(getAddress(strategyVault.address)) ?? [],
      totalExposureUsd: exposureUsdPrices.value.get(key) ?? 0,
      totalSupplyState,
      utilization: strategyVault.utilization,
      acceptedCollateralCount: strategyVault.collaterals.length,
    }))
  }
  return result
})

const getStrategyExposureDisplay = (strategyVault: EVault | undefined): VaultExposureDisplay =>
  (strategyVault && strategyExposureDisplayByAddress.value.get(strategyVault.address.toLowerCase()))
  || { valueState: 'unavailable', items: [] }

watch(isMarketDataResolved, () => {
  if (!exposureVaults.value.length) return
  void loadExposureUsdPrices()
})

watchEffect(() => {
  if (!exposureRows.value.length || !isOpenInterestEnabled.value) return
  void loadOpenInterest()
})

const getAllocationPercentage = (exposure: EulerEarnStrategyInfo) => {
  if (totalAllocatedAssets.value === 0n) return 0
  return Number(exposure.allocatedAssets) / Number(totalAllocatedAssets.value) * 100
}

const getStrategySupplyApy = (strategyVault: EVault) => {
  const lendingAPY = getVaultSupplyApy(strategyVault)
  const supplyApy = withVaultIntrinsicApy(lendingAPY, strategyVault, enableIntrinsicApy.value)
  return supplyApy + getSupplyRewardApy(strategyVault.address)
}

const getStrategySupplyApyModalData = (strategyVault: EVault) => ({
  props: {
    mode: 'supply',
    lendingAPY: getVaultSupplyApy(strategyVault),
    intrinsicAPY: getVaultIntrinsicApy(strategyVault, enableIntrinsicApy.value),
    intrinsicApyInfo: getVaultIntrinsicApyInfo(strategyVault, enableIntrinsicApy.value),
    campaigns: getSupplyRewardCampaigns(strategyVault.address),
    rewardVaultAddress: strategyVault.address,
  },
})

const hasExposureUsdPrice = (exposure: typeof exposureList.value[0]) => {
  return exposureUsdPrices.value.has(exposure.address.toLowerCase())
}

const getExposureUsdPrice = (exposure: typeof exposureList.value[0]) => {
  return exposureUsdPrices.value.get(exposure.address.toLowerCase()) || 0
}

const getExposureAssetAmount = (exposure: typeof exposureList.value[0]) => {
  const strategyVault = exposure.vault as EVault | undefined ?? getExposureVaultByAddress(exposure.address)
  return `${roundAndCompactTokens(exposure.allocatedAssets, strategyVault?.asset.decimals ?? 18)} ${strategyVault?.asset.symbol ?? ''}`
}

load()
</script>

<template>
  <VaultOverviewAccordionSection
    v-if="exposureList.length"
    title="Exposure"
    :default-open="defaultOpen"
    content-class="flex flex-col gap-12"
  >
    <div
      v-if="isLoading"
      class="flex items-center justify-center py-32"
    >
      <UiLoader class="icon--48" />
    </div>

    <div
      v-else
      class="flex flex-col gap-12"
    >
      <div
        v-for="row in exposureRows"
        :key="row.exposure.address"
        class="cursor-pointer rounded-12 border border-line-default bg-surface p-16 text-content-primary shadow-card transition-colors hover:bg-card-hover"
        @click="onExposureClick(row.exposure.address)"
      >
        <div
          class="flex items-start justify-between gap-12 mobile:flex-wrap"
        >
          <template v-if="row.vault">
            <VaultLabelsAndAssets
              class="min-w-0 flex-1 mobile:order-1"
              :vault="row.vault"
              :assets="[{
                address: row.vault.asset.address,
                decimals: row.vault.asset.decimals,
                name: row.vault.asset.name,
                symbol: row.vault.asset.symbol,
              }]"
            >
              <span
                v-if="row.hookWarning"
                @click.stop.prevent
              >
                <VaultWarningIcon :warning="row.hookWarning" />
              </span>
            </VaultLabelsAndAssets>
          </template>
          <template v-else>
            <div class="flex items-center gap-12 min-w-0 flex-1 mobile:order-1">
              <AssetAvatar
                :asset="{ address: row.exposure.vault?.asset.address ?? row.exposure.address, symbol: row.exposure.vault?.asset.symbol ?? '' }"
                size="40"
              />
              <div>
                <div class="text-content-tertiary text-p3">
                  {{ row.exposure.vault ? (row.exposure.vault as EVault).shares.name : row.exposure.address }}
                </div>
                <div class="text-h5 text-content-primary">
                  {{ row.exposure.vault?.asset.symbol ?? '' }}
                </div>
              </div>
            </div>
          </template>
          <div
            v-if="row.vault"
            class="flex flex-col items-end shrink-0 mobile:contents"
          >
            <div class="flex flex-col items-end shrink-0 mobile:order-2">
              <div class="text-content-tertiary text-p3 mb-4 flex items-center gap-4">
                Supply APY
                <UiModalPreviewTrigger
                  :component="VaultApyModal"
                  :modal-data="getStrategySupplyApyModalData(row.vault)"
                  aria-label="Show supply APY breakdown"
                >
                  <SvgIcon
                    class="!w-16 !h-16 shrink-0 text-content-muted hover:text-content-secondary transition-colors cursor-pointer"
                    name="info-circle"
                  />
                </UiModalPreviewTrigger>
              </div>
              <div class="text-p2 flex items-center text-accent-600 font-semibold">
                <UiModalPreviewTrigger
                  v-if="hasSupplyRewards(row.vault.address)"
                  :component="VaultApyModal"
                  :modal-data="getStrategySupplyApyModalData(row.vault)"
                  aria-label="Show supply APY rewards breakdown"
                >
                  <SvgIcon
                    class="!w-20 !h-20 text-accent-500 mr-4 cursor-pointer"
                    name="sparks"
                  />
                </UiModalPreviewTrigger>
                {{ formatNumber(getStrategySupplyApy(row.vault)) }}%
              </div>
            </div>
            <VaultTypeBadges
              class="justify-end mt-8 mobile:order-3 mobile:basis-full mobile:justify-end mobile:mt-0 mobile:pt-4"
              :vault="row.vault"
              summary-only
              @click.stop.prevent
            />
          </div>
        </div>
        <div class="flex flex-col gap-12 pt-12">
          <VaultOverviewLabelValue
            orientation="horizontal"
            data-list="earn-exposure-strategy"
            :data-key="getAddress(row.exposure.address)"
            data-field="Current exposure"
          >
            <template #label>
              <span class="flex items-center gap-4">
                Current exposure
                <span @click.stop.prevent>
                  <UiHoverPreviewTooltip
                    title="Current exposure"
                    text="The collateral assets currently backing borrows in this strategy."
                    icon-class="!w-20 !h-20 text-content-muted hover:text-content-secondary"
                  />
                </span>
              </span>
            </template>
            <VaultExposureSummary
              :items="getStrategyExposureDisplay(row.vault).items"
              :value-state="getStrategyExposureDisplay(row.vault).valueState"
              :max-visible="5"
              avatar-size="20"
            />
          </VaultOverviewLabelValue>
          <VaultOverviewLabelValue
            label="Exposure amount"
            orientation="horizontal"
            data-list="earn-exposure-strategy"
            :data-key="getAddress(row.exposure.address)"
            data-field="Exposure amount"
          >
            <template v-if="hasExposureUsdPrice(row.exposure)">
              {{ formatCompactUsdValue(getExposureUsdPrice(row.exposure)) }}
              <span class="text-content-secondary">({{ compactNumber(getAllocationPercentage(row.exposure), 2) }}%)</span>
            </template>
            <template v-else>
              <UiExactAmount :exact="formatExactAmount(row.exposure.allocatedAssets, row.vault?.asset.decimals ?? 18, row.vault?.asset.symbol)">
                {{ getExposureAssetAmount(row.exposure) }}
              </UiExactAmount>
              <span class="text-content-secondary">({{ compactNumber(getAllocationPercentage(row.exposure), 2) }}%)</span>
            </template>
          </VaultOverviewLabelValue>
          <VaultOverviewLabelValue
            orientation="horizontal"
            data-list="earn-exposure-strategy"
            :data-key="getAddress(row.exposure.address)"
            data-field="Exposure cap"
          >
            <template #label>
              <span class="flex items-center gap-4">
                Exposure cap
                <span @click.stop.prevent>
                  <UiHoverPreviewTooltip
                    title="Exposure cap"
                    text="The maximum amount that can be exposed to this strategy."
                    icon-class="!w-20 !h-20 text-content-muted hover:text-content-secondary"
                  />
                </span>
              </span>
            </template>
            <span class="flex items-center gap-4">
              <span
                v-if="isPendingRemoval(row.exposure)"
                @click.stop.prevent
              >
                <UiHoverPreviewTooltip
                  icon="clock"
                  title="Pending removal"
                  :text="getPendingRemovalTooltipText(row.exposure)"
                  icon-class="!w-14 !h-14 text-warning-500"
                />
              </span>
              <template v-if="isUnlimitedCap(row.exposure)">
                ∞
              </template>
              <template v-else-if="exposureCapUsdPrices.has(row.exposure.address.toLowerCase())">
                {{ formatCompactUsdValue(exposureCapUsdPrices.get(row.exposure.address.toLowerCase()) || 0) }}
              </template>
              <template v-else>
                <UiExactAmount :exact="formatExactAmount(row.exposure.allocationCap.current, row.vault?.asset.decimals ?? 18, row.vault?.asset.symbol)">
                  {{ roundAndCompactTokens(row.exposure.allocationCap.current, row.vault?.asset.decimals ?? 18) }} {{ row.vault?.asset.symbol }}
                </UiExactAmount>
              </template>
            </span>
          </VaultOverviewLabelValue>
        </div>
      </div>
    </div>
  </VaultOverviewAccordionSection>
</template>

<style lang="scss" scoped>
.footnote-info:deep(.ui-footnote__icon) {
  width: 20px;
  height: 20px;
}

.footnote-info {
  width: 20px;
  height: 20px;
}

.footnote-clock:deep(.ui-footnote__icon) {
  width: 14px;
  height: 14px;
}

.footnote-clock {
  width: 14px;
  height: 14px;
}
</style>
