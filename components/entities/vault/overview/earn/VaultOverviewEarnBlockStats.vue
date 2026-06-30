<script setup lang="ts">
import { isEVault, type EVault, type EulerEarn, type EulerEarnStrategyInfo, type SecuritizeCollateralVault } from '@eulerxyz/euler-v2-sdk'
import { formatAssetValue } from '~/utils/sdk-prices'
import { formatNumber, formatCompactUsdValue } from '~/utils/string-utils'
import { VaultSupplyApyModal, UiModalPreviewTrigger } from '#components'
import { getVaultIntrinsicApy, getVaultIntrinsicApyInfo } from '~/utils/vault-intrinsic-apy'
import { getCollateralExposureGroups, getCollateralExposurePairs } from '~/utils/vault/collateral-exposure'
import { getProductByVault, getProductKeyByVault } from '~/utils/eulerLabelsUtils'
import {
  buildAllocatedVaultExposureDisplayItems,
  mergeVaultExposureDisplayItems,
  type ExposureValueState,
} from '~/utils/vault/exposure-display'

const { vault } = defineProps<{ vault: EulerEarn }>()
const route = useRoute()

const { settings } = useUserSettings()
const enableIntrinsicApy = computed(() => settings.value.enableIntrinsicApy)
const { getSupplyRewardApy, getSupplyRewardCampaigns, hasSupplyRewards } = useRewardsApy()
const { get: registryGet } = useVaultRegistry()
const {
  load: loadOpenInterest,
  getOpenInterestForVault,
  hasError: hasOpenInterestError,
  isLoaded: isOpenInterestLoaded,
} = useCollateralOpenInterest()

const rewardSupplyAPY = computed(() => getSupplyRewardApy(vault.address))
const strategyAllocationUsdByAddress = ref<Map<string, number>>(new Map())
let strategyAllocationLoadId = 0

const getStrategyVault = (strategy: EulerEarnStrategyInfo): EVault | undefined => {
  if (strategy.vault && isEVault(strategy.vault)) return strategy.vault as EVault
  const entry = registryGet(strategy.address)
  return entry?.vault && isEVault(entry.vault) ? entry.vault as EVault : undefined
}
const getStrategyMarketSource = (strategyVault: EVault) => {
  const marketKey = getProductKeyByVault(strategyVault.address)
  const marketName = getProductByVault(strategyVault.address).name || strategyVault.asset.symbol
  return {
    label: marketName,
    to: marketKey
      ? {
          name: 'explore-market',
          params: { market: marketKey },
          query: { network: route.query.network },
        }
      : undefined,
  }
}

const hasLiveExposureData = computed(() => isOpenInterestLoaded.value && !hasOpenInterestError.value)
const isStrategyAllocationUsdLoaded = computed(() =>
  vault.strategies.every((strategy) => {
    const strategyVault = getStrategyVault(strategy)
    return !strategyVault || strategyAllocationUsdByAddress.value.has(strategy.address.toLowerCase())
  }),
)
const exposureValueState = computed<ExposureValueState>(() => {
  if (!isStrategyAllocationUsdLoaded.value) return 'loading'
  if (hasLiveExposureData.value) return 'ready'
  if (hasOpenInterestError.value) return 'unavailable'
  return 'loading'
})
const exposureDisplayItems = computed(() =>
  hasLiveExposureData.value && isStrategyAllocationUsdLoaded.value
    ? mergeVaultExposureDisplayItems(
        vault.strategies.flatMap((strategy) => {
          const strategyVault = getStrategyVault(strategy)
          if (!strategyVault) return []

          const collateralGroups = getCollateralExposureGroups(
            getCollateralExposurePairs(
              strategyVault,
              addr => registryGet(addr)?.vault as EVault | SecuritizeCollateralVault | undefined,
            ),
            getOpenInterestForVault(strategyVault.address),
          )

          return buildAllocatedVaultExposureDisplayItems({
            collateralGroups,
            totalExposureUsd: strategyAllocationUsdByAddress.value.get(strategy.address.toLowerCase()) ?? 0,
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
  const results = await Promise.all(vault.strategies.map(async (strategy) => {
    const strategyVault = getStrategyVault(strategy)
    if (!strategyVault) return null

    const price = await formatAssetValue(strategy.allocatedAssets, strategyVault, 'off-chain')
    return {
      address: strategy.address.toLowerCase(),
      valueUsd: price.hasPrice ? price.usdValue : 0,
    }
  }))
  if (loadId !== strategyAllocationLoadId) return

  strategyAllocationUsdByAddress.value = new Map(
    results
      .filter((result): result is { address: string, valueUsd: number } => Boolean(result))
      .map(result => [result.address, result.valueUsd]),
  )
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
    lendingAPY: getVaultSupplyApy(vault),
    intrinsicAPY: getVaultIntrinsicApy(vault, enableIntrinsicApy.value),
    intrinsicApyInfo: getVaultIntrinsicApyInfo(vault, enableIntrinsicApy.value),
    campaigns: getSupplyRewardCampaigns(vault.address),
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
            v-if="hasSupplyRewards(vault.address)"
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
          {{ formatNumber(getVaultSupplyApy(vault) + rewardSupplyAPY) }}%
        </span>
      </VaultOverviewLabelValue>
    </div>
  </div>
</template>
