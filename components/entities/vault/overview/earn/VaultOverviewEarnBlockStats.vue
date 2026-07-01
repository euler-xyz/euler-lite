<script setup lang="ts">
import { computeSupplyApyBreakdown, isEVault, type EVault, type EulerEarn, type EulerEarnStrategyInfo, type SecuritizeCollateralVault } from '@eulerxyz/euler-v2-sdk'
import { formatAssetValue } from '~/utils/sdk-prices'
import { formatNumber, formatCompactUsdValue } from '~/utils/string-utils'
import { VaultSupplyApyModal, UiModalPreviewTrigger } from '#components'
import { getVaultIntrinsicApyInfo } from '~/utils/vault-intrinsic-apy'
import { getCollateralExposureGroups, getCollateralExposurePairs } from '~/utils/vault/collateral-exposure'
import { getProductByVault, getProductKeyByVault } from '~/utils/eulerLabelsUtils'
import {
  buildAllocatedVaultExposureDisplayItems,
  hasMissingUtilizedExposureSplit,
  mergeVaultExposureDisplayItems,
  type ExposureValueState,
} from '~/utils/vault/exposure-display'
import { logWarn } from '~/utils/errorHandling'

const { vault } = defineProps<{ vault: EulerEarn }>()
const route = useRoute()

const { settings } = useUserSettings()
const enableIntrinsicApy = computed(() => settings.value.enableIntrinsicApy)
const { getSupplyRewardCampaigns, hasSupplyRewards } = useRewardsApy()
const { viewer, visibleTotal, visibleBreakdown } = useApyVisibility()
const { get: registryGet } = useVaultRegistry()
const {
  load: loadOpenInterest,
  getOpenInterestForVault,
  hasError: hasOpenInterestError,
  isLoaded: isOpenInterestLoaded,
} = useCollateralOpenInterest()

const supplyApyBreakdown = computed(() => computeSupplyApyBreakdown(vault, viewer.value))
const visibleApyBreakdown = computed(() => visibleBreakdown(supplyApyBreakdown.value))
const supplyApyTotal = computed(() => visibleTotal(supplyApyBreakdown.value) ?? 0)
const hasRewards = computed(() => settings.value.enableRewardsApy && hasSupplyRewards(vault.address))
interface StrategyAllocationUsd {
  valueUsd: number
  valueState: ExposureValueState
}

const strategyAllocationUsdByAddress = ref<Map<string, StrategyAllocationUsd>>(new Map())
let strategyAllocationLoadId = 0

const getStrategyVault = (strategy: EulerEarnStrategyInfo): EVault | undefined => {
  if (strategy.vault && isEVault(strategy.vault)) return strategy.vault as EVault
  const entry = registryGet(strategy.address)
  return entry?.vault && isEVault(entry.vault) ? entry.vault as EVault : undefined
}
const getStrategyMarketSource = (strategyVault: EVault) => {
  const marketKey = getProductKeyByVault(strategyVault.address)
  if (!marketKey) return undefined

  const marketName = getProductByVault(strategyVault.address).name || strategyVault.asset.symbol
  return {
    label: marketName,
    to: {
      name: 'explore-market',
      params: { market: marketKey },
      query: { network: route.query.network },
    },
  }
}

const hasLiveExposureData = computed(() => isOpenInterestLoaded.value && !hasOpenInterestError.value)
const isStrategyAllocationUsdLoaded = computed(() =>
  vault.strategies.every((strategy) => {
    const strategyVault = getStrategyVault(strategy)
    return !strategyVault || strategyAllocationUsdByAddress.value.has(strategy.address.toLowerCase())
  }),
)
const hasUnavailableStrategyAllocationUsd = computed(() =>
  [...strategyAllocationUsdByAddress.value.values()].some(allocation => allocation.valueState === 'unavailable'),
)
const getStrategyCollateralGroups = (strategyVault: EVault) =>
  getCollateralExposureGroups(
    getCollateralExposurePairs(
      strategyVault,
      addr => registryGet(addr)?.vault as EVault | SecuritizeCollateralVault | undefined,
    ),
    getOpenInterestForVault(strategyVault.address),
  )
const hasUnavailableExposureSplit = computed(() => {
  if (!hasLiveExposureData.value || !isStrategyAllocationUsdLoaded.value) return false

  return vault.strategies.some((strategy) => {
    const strategyVault = getStrategyVault(strategy)
    if (!strategyVault) return false

    const allocation = strategyAllocationUsdByAddress.value.get(strategy.address.toLowerCase())
    if (!allocation || allocation.valueState !== 'ready' || allocation.valueUsd <= 0) return false

    return hasMissingUtilizedExposureSplit(getStrategyCollateralGroups(strategyVault), strategyVault.utilization)
  })
})
const exposureValueState = computed<ExposureValueState>(() => {
  if (!vault.strategies.length) return 'ready'
  if (!isStrategyAllocationUsdLoaded.value) return 'loading'
  if (hasOpenInterestError.value) return 'unavailable'
  if (hasUnavailableStrategyAllocationUsd.value) return 'unavailable'
  if (hasUnavailableExposureSplit.value) return 'unavailable'
  if (!isOpenInterestLoaded.value) return 'loading'
  return 'ready'
})
const exposureDisplayItems = computed(() =>
  exposureValueState.value === 'ready'
    ? mergeVaultExposureDisplayItems(
        vault.strategies.flatMap((strategy) => {
          const strategyVault = getStrategyVault(strategy)
          if (!strategyVault) return []

          const allocation = strategyAllocationUsdByAddress.value.get(strategy.address.toLowerCase())
          if (!allocation) return []

          return buildAllocatedVaultExposureDisplayItems({
            collateralGroups: getStrategyCollateralGroups(strategyVault),
            totalExposureUsd: allocation.valueUsd,
            idleAsset: strategyVault.asset,
            utilization: strategyVault.utilization,
            idleSource: getStrategyMarketSource(strategyVault),
          })
        }),
      )
    : [],
)

watchEffect(() => {
  if (!vault.strategies.length) return
  void loadOpenInterest()
})

watchEffect(async () => {
  const loadId = ++strategyAllocationLoadId
  try {
    const results = await Promise.all(vault.strategies.map(async (strategy) => {
      const strategyVault = getStrategyVault(strategy)
      if (!strategyVault) return null

      const price = await formatAssetValue(strategy.allocatedAssets, strategyVault, 'off-chain')
      return {
        address: strategy.address.toLowerCase(),
        valueUsd: price.hasPrice ? price.usdValue : 0,
        valueState: price.hasPrice ? 'ready' : 'unavailable',
      }
    }))
    if (loadId !== strategyAllocationLoadId) return

    strategyAllocationUsdByAddress.value = new Map(
      results
        .filter((result): result is { address: string } & StrategyAllocationUsd => Boolean(result))
        .map(result => [result.address, {
          valueUsd: result.valueUsd,
          valueState: result.valueState,
        }]),
    )
  }
  catch (e) {
    if (loadId !== strategyAllocationLoadId) return

    logWarn('VaultOverviewEarnBlockStats/loadStrategyAllocationUsd', e)
    strategyAllocationUsdByAddress.value = new Map(
      vault.strategies
        .filter(strategy => Boolean(getStrategyVault(strategy)))
        .map(strategy => [strategy.address.toLowerCase(), {
          valueUsd: 0,
          valueState: 'unavailable',
        }]),
    )
  }
})

const totalSupplyDisplay = ref('-')

watchEffect(async () => {
  const price = await formatAssetValue(vault.totalAssets, vault, 'off-chain')
  totalSupplyDisplay.value = price.hasPrice ? formatCompactUsdValue(price.usdValue) : price.display
})

const availableLiquidityDisplay = ref('-')

watchEffect(async () => {
  const price = await formatAssetValue(vault.availableAssets, vault, 'off-chain')
  availableLiquidityDisplay.value = price.hasPrice ? formatCompactUsdValue(price.usdValue) : price.display
})

const supplyApyModalData = computed(() => ({
  props: {
    lendingAPY: visibleApyBreakdown.value?.lending ?? 0,
    intrinsicAPY: visibleApyBreakdown.value?.intrinsicApy ?? 0,
    intrinsicApyInfo: getVaultIntrinsicApyInfo(vault, enableIntrinsicApy.value),
    campaigns: settings.value.enableRewardsApy ? getSupplyRewardCampaigns(vault.address) : [],
    totalSupplyAPY: supplyApyTotal.value,
    rewardVaultAddress: vault.address,
    baseApyAverageLabel: '1h',
  },
}))
</script>

<template>
  <div class="bg-surface-secondary rounded-xl flex flex-col gap-24 p-24 shadow-card">
    <p class="text-h3 text-content-primary">
      Statistics
    </p>
    <div class="flex flex-col items-start gap-24">
      <VaultOverviewLabelValue
        label="Total supply"
        :value="totalSupplyDisplay"
        orientation="horizontal"
      />
      <VaultOverviewLabelValue
        label="Available liquidity"
        :value="availableLiquidityDisplay"
        orientation="horizontal"
      />
      <VaultOverviewLabelValue
        label="Total strategies"
        orientation="horizontal"
        data-field="Total strategies"
        :data-value="vault.strategies.length"
      >
        <div class="flex min-w-0 items-center justify-end gap-12">
          <span class="text-p2 text-content-primary">
            {{ vault.strategies.length }}
          </span>
          <span class="h-16 w-1 shrink-0 bg-line-subtle" />
          <VaultExposureSummary
            :items="exposureDisplayItems"
            :value-state="exposureValueState"
            :max-visible="5"
            avatar-size="20"
          />
        </div>
      </VaultOverviewLabelValue>
      <VaultOverviewLabelValue
        orientation="horizontal"
      >
        <template #label>
          <span class="flex items-center gap-6">
            Supply APY
            <span class="inline-flex items-center rounded-8 px-8 py-2 bg-accent-100 text-accent-600 text-p5">
              1h
            </span>
          </span>
        </template>
        <span class="flex items-center gap-4">
          <UiModalPreviewTrigger
            v-if="hasRewards"
            :component="VaultSupplyApyModal"
            :modal-data="supplyApyModalData"
            aria-label="Show supply APY rewards breakdown"
          >
            <SvgIcon
              class="!w-20 !h-20 text-accent-500 cursor-pointer"
              name="sparks"
              data-modal-trigger="supply-apy"
            />
          </UiModalPreviewTrigger>
          {{ formatNumber(supplyApyTotal) }}%
        </span>
      </VaultOverviewLabelValue>
    </div>
  </div>
</template>
