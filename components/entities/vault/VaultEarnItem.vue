<script setup lang="ts">
import { computeSupplyApyBreakdown, isEVault, type EVault, type EulerEarn, type EulerEarnStrategyInfo, type SecuritizeCollateralVault } from '@eulerxyz/euler-v2-sdk'

import { formatAssetValue } from '~/utils/sdk-prices'
import { useEulerProductOfVault, useEulerEntitiesOfEarnVault } from '~/composables/useEulerLabels'
import { isVaultRecentlyAdded, getEarnVaultDescription } from '~/utils/eulerLabelsUtils'
import { getEulerLabelEntityLogo } from '~/entities/euler/labels'
import { getVaultIntrinsicApyInfo } from '~/utils/vault-intrinsic-apy'
import { isVaultBlockedByCountry } from '~/composables/useGeoBlock'
import { compactNumber, formatNumber, formatCompactUsdValue } from '~/utils/string-utils'
import BaseLoadableContent from '~/components/base/BaseLoadableContent.vue'
import { VaultSupplyApyModal, UiModalPreviewTrigger } from '#components'
import {
  getCollateralExposureGroups,
  getCollateralExposurePairs,
  mergeCollateralExposureGroupsByBackingAsset,
} from '~/utils/vault/collateral-exposure'

const { isConnected } = useWagmi()
const { vault } = defineProps<{ vault: EulerEarn }>()
const product = useEulerProductOfVault(vault.address)
const { enableEntityBranding } = useDeployConfig()
const { isEarnVaultOwnerVerified } = useVaults()
const { get: registryGet, isVerifiedVault } = useVaultRegistry()
const {
  load: loadOpenInterest,
  getOpenInterestForVault,
  hasError: hasOpenInterestError,
  isLoaded: isOpenInterestLoaded,
} = useCollateralOpenInterest()
const entities = useEulerEntitiesOfEarnVault(vault)
const isOwnerVerified = computed(() => isEarnVaultOwnerVerified(vault))
const entityName = computed(() => {
  if (!isOwnerVerified.value || entities.length === 0) return ''
  if (entities.length === 1) return entities[0].name
  if (entities.length === 2) return `${entities[0].name} & ${entities[1].name}`
  return `${entities[0].name} & others`
})
const entityLogos = computed(() => {
  if (!entityName.value || entities.length === 0) return []
  return entities.map(e => getEulerLabelEntityLogo(e.logo))
})
const { getBalance, isLoading: isBalancesLoading } = useWallets()
const { settings } = useUserSettings()
const enableIntrinsicApy = computed(() => settings.value.enableIntrinsicApy)
const { viewer } = useApyVisibility()
const { hasSupplyRewards, getSupplyRewardCampaigns } = useRewardsApy()

const balance = computed(() =>
  getBalance(vault.asset.address as `0x${string}`),
)
const supplyApyBreakdown = computed(() => computeSupplyApyBreakdown(vault, viewer.value))
const visibleLendingApy = computed(() => supplyApyBreakdown.value?.lending ?? getVaultSupplyApy(vault))
const visibleIntrinsicApy = computed(() => {
  if (!enableIntrinsicApy.value) return 0
  return supplyApyBreakdown.value?.intrinsicApy ?? 0
})
const visibleRewardsApy = computed(() => {
  if (!settings.value.enableRewardsApy) return 0
  return supplyApyBreakdown.value?.rewards ?? 0
})
const visibleSupplyApy = computed(() => {
  const borrowing = supplyApyBreakdown.value?.borrowing ?? 0
  return visibleLendingApy.value + borrowing + visibleIntrinsicApy.value + visibleRewardsApy.value
})
const hasRewards = computed(() => settings.value.enableRewardsApy && hasSupplyRewards(vault.address))
const isGeoBlocked = computed(() => isVaultBlockedByCountry(vault.address))
const isRecentlyAdded = computed(() => isVaultRecentlyAdded(vault.address))
const isUnverified = computed(() => !isVerifiedVault(vault.address))
const displayName = computed(() => product.name || vault.shares.name)
const description = computed(() => getEarnVaultDescription(vault.address))
const getStrategyVault = (strategy: EulerEarnStrategyInfo): EVault | undefined => {
  if (strategy.vault && isEVault(strategy.vault)) return strategy.vault as EVault
  const entry = registryGet(strategy.address)
  return entry?.vault && isEVault(entry.vault) ? entry.vault as EVault : undefined
}
const combinedCollateralExposureGroups = computed(() =>
  mergeCollateralExposureGroupsByBackingAsset(
    vault.strategies.flatMap((strategy) => {
      const strategyVault = getStrategyVault(strategy)
      if (!strategyVault) return []

      return getCollateralExposureGroups(
        getCollateralExposurePairs(
          strategyVault,
          addr => registryGet(addr)?.vault as EVault | SecuritizeCollateralVault | undefined,
        ),
        getOpenInterestForVault(strategyVault.address),
      )
    }),
  ),
)
const topCollateralExposureGroup = computed(() => combinedCollateralExposureGroups.value[0])
const totalCollateralExposureUsd = computed(() =>
  combinedCollateralExposureGroups.value.reduce((sum, group) => sum + group.openInterestUsd, 0),
)
const hasLiveExposureData = computed(() => isOpenInterestLoaded.value && !hasOpenInterestError.value)
const allocationSummary = computed(() => {
  const group = topCollateralExposureGroup.value
  if (!group) return '-'
  if (!hasLiveExposureData.value) return 'Unavailable'

  const pct = totalCollateralExposureUsd.value > 0
    ? compactNumber(group.openInterestUsd / totalCollateralExposureUsd.value * 100, 1, 0)
    : '0'

  return `Top: ${group.asset.symbol} ${formatCompactUsdValue(group.openInterestUsd)} · ${pct}%`
})

watchEffect(() => {
  if (!vault.strategies.length) return
  void loadOpenInterest()
})

const prices = ref<{ totalSupply: string, liquidity: string, walletBalance: string }>({
  totalSupply: '-',
  liquidity: '-',
  walletBalance: '-',
})

watchEffect(async () => {
  const walletBal = balance.value
  const [supplyResult, liquidityResult, walletResult] = await Promise.all([
    formatAssetValue(vault.totalAssets, vault, 'off-chain'),
    formatAssetValue(vault.availableAssets, vault, 'off-chain'),
    formatAssetValue(walletBal, vault, 'off-chain'),
  ])
  prices.value = {
    totalSupply: supplyResult.hasPrice ? formatCompactUsdValue(supplyResult.usdValue) : supplyResult.display,
    liquidity: liquidityResult.hasPrice ? formatCompactUsdValue(liquidityResult.usdValue) : liquidityResult.display,
    walletBalance: walletResult.hasPrice ? formatCompactUsdValue(walletResult.usdValue) : walletResult.display,
  }
})

const statsGridCols = computed(() => {
  const cols: string[] = []
  if (enableEntityBranding) cols.push('1fr')
  cols.push('1fr') // Total supply
  cols.push('1fr') // Available liquidity
  cols.push('1fr') // Strategies
  if (isConnected.value) cols.push('1fr') // In wallet
  return cols.join(' ')
})

const supplyApyModalData = computed(() => ({
  props: {
    lendingAPY: visibleLendingApy.value,
    intrinsicAPY: visibleIntrinsicApy.value,
    intrinsicApyInfo: getVaultIntrinsicApyInfo(vault, enableIntrinsicApy.value),
    campaigns: settings.value.enableRewardsApy ? getSupplyRewardCampaigns(vault.address) : [],
    totalSupplyAPY: visibleSupplyApy.value,
    rewardVaultAddress: vault.address,
    baseApyAverageLabel: '1h',
  },
}))
</script>

<template>
  <NuxtLink
    class="block no-underline bg-surface rounded-xl border border-line-default shadow-card transition-all duration-default ease-default hover:shadow-card-hover hover:border-line-emphasis"
    :class="isGeoBlocked ? 'opacity-50' : ''"
    :to="{ path: `/earn/${vault.address}`, query: { network: $route.query.network } }"
    data-id="vault-list-item"
    data-list="earn"
    :data-key="vault.address.toLowerCase()"
    :data-vault-address="vault.address.toLowerCase()"
  >
    <div class="flex items-start gap-12 py-16 px-16 pb-12 border-b border-line-subtle">
      <AssetAvatar
        :asset="vault.asset"
        size="40"
      />
      <div class="min-w-0 flex-1">
        <div
          class="text-content-tertiary text-p3 mb-4 flex items-center gap-8"
          data-id="data-point"
          :data-key="vault.address.toLowerCase()"
          data-field="name"
          :data-value="displayName"
        >
          <VaultDisplayName
            :name="displayName"
            :is-unverified="isUnverified"
          />
          <RecentlyAddedBadge
            v-if="isRecentlyAdded"
          />
          <RestrictedBadge v-if="isGeoBlocked" />
        </div>
        <div
          class="text-h5 text-content-primary"
          data-id="data-point"
          :data-key="vault.address.toLowerCase()"
          data-field="asset-symbol"
          :data-value="vault.asset.symbol"
        >
          {{ vault.asset.symbol }}
        </div>
        <div
          v-if="description"
          class="text-p3 text-content-tertiary mt-4 max-w-[85%] line-clamp-1 mobile:max-w-full"
          data-id="data-point"
          :data-key="vault.address.toLowerCase()"
          data-field="description"
          :data-value="description"
        >
          {{ description }}
        </div>
      </div>
      <div class="flex flex-col items-end shrink-0 ml-16">
        <div class="text-content-tertiary text-p3 mb-4 text-right flex items-center gap-4">
          Supply APY
          <span class="inline-flex items-center rounded-8 px-8 py-2 bg-accent-100 text-accent-600 text-p5">
            1h
          </span>
          <UiModalPreviewTrigger
            :component="VaultSupplyApyModal"
            :modal-data="supplyApyModalData"
            aria-label="Show supply APY breakdown"
          >
            <SvgIcon
              class="!w-16 !h-16 shrink-0 text-content-muted hover:text-content-secondary transition-colors cursor-pointer"
              name="info-circle"
              data-modal-trigger="supply-apy"
            />
          </UiModalPreviewTrigger>
        </div>
        <div
          class="text-p2 flex items-center text-accent-600"
          data-id="data-point"
          :data-key="vault.address.toLowerCase()"
          data-field="supply-apy"
          :data-value="visibleSupplyApy"
        >
          <div class="mr-6">
            <VaultPoints :vault="vault" />
          </div>
          <UiModalPreviewTrigger
            v-if="hasRewards"
            :component="VaultSupplyApyModal"
            :modal-data="supplyApyModalData"
            aria-label="Show supply APY rewards breakdown"
          >
            <SvgIcon
              class="!w-20 !h-20 text-accent-600 mr-4 cursor-pointer"
              name="sparks"
              data-modal-trigger="supply-apy"
            />
          </UiModalPreviewTrigger>
          {{ formatNumber(visibleSupplyApy) }}%
        </div>
      </div>
    </div>
    <div
      class="grid gap-x-16 py-12 px-16 pb-12 mobile:!flex mobile:justify-between mobile:border-b mobile:border-line-subtle mobile:pb-12"
      :style="{ gridTemplateColumns: statsGridCols }"
    >
      <div
        v-if="enableEntityBranding"
        class="flex-1 mobile:!hidden"
      >
        <div class="text-content-tertiary text-p3 mb-4">Capital allocator</div>
        <div
          v-if="!isOwnerVerified"
          class="flex gap-8 items-center py-4 px-8 rounded-8 bg-error-100 text-error-500 text-p2 w-fit"
        >
          <SvgIcon
            name="warning"
            class="!w-16 !h-16"
          />
          Unknown
        </div>
        <div
          v-else-if="entityName"
          class="flex items-center gap-6"
        >
          <BaseAvatar
            class="icon--20"
            :label="entityName"
            :src="entityLogos"
          />
          <span
            class="text-p2 text-content-primary truncate"
            data-id="data-point"
            :data-key="vault.address.toLowerCase()"
            data-field="capital-allocator"
            :data-value="entityName"
          >{{ entityName }}</span>
        </div>
        <div
          v-else
          class="text-p2 text-content-primary"
        >-</div>
      </div>
      <div class="flex-1 flex flex-col items-center mobile:items-start">
        <div class="text-content-tertiary text-p3 mb-4">Total supply</div>
        <div
          class="text-p2 text-content-primary"
          data-id="data-point"
          :data-key="vault.address.toLowerCase()"
          data-field="total-supply"
          :data-value="prices.totalSupply"
        >
          {{ prices.totalSupply }}
        </div>
      </div>
      <div class="flex-1 flex flex-col items-center mobile:items-end">
        <div class="text-content-tertiary text-p3 mb-4">
          Available liquidity
        </div>
        <div
          class="text-p2 text-content-primary"
          data-id="data-point"
          :data-key="vault.address.toLowerCase()"
          data-field="available-liquidity"
          :data-value="prices.liquidity"
        >
          {{ prices.liquidity }}
        </div>
      </div>
      <div
        class="flex flex-col flex-1 mobile:!hidden"
        :class="isConnected ? 'items-center' : 'items-end text-right'"
      >
        <div class="text-content-tertiary text-p3 mb-4">
          Allocates into
        </div>
        <div
          class="flex min-w-0 flex-col items-end gap-4"
          data-id="data-point"
          :data-key="vault.address.toLowerCase()"
          data-field="allocates-into"
          :data-value="allocationSummary"
        >
          <div class="flex min-w-0 items-center justify-end gap-6">
            <AssetAvatar
              v-if="topCollateralExposureGroup && hasLiveExposureData"
              :asset="topCollateralExposureGroup.asset"
              size="20"
            />
            <span class="text-p2 text-content-primary whitespace-nowrap">
              {{ allocationSummary }}
            </span>
          </div>
        </div>
      </div>
      <div class="flex flex-col flex-1 items-end text-right mobile:!hidden">
        <template v-if="isConnected">
          <div class="text-content-tertiary text-p3 mb-4">In wallet</div>
          <BaseLoadableContent
            :loading="isBalancesLoading"
            style="width: 70px; height: 20px"
          >
            <div
              class="text-p2 text-content-primary"
              data-id="data-point"
              :data-key="vault.address.toLowerCase()"
              data-field="wallet-balance"
              :data-value="prices.walletBalance"
            >
              {{ prices.walletBalance }}
            </div>
          </BaseLoadableContent>
        </template>
      </div>
    </div>
    <div class="hidden mobile:flex mobile:flex-col gap-12 py-12 px-16 pb-16">
      <div
        v-if="enableEntityBranding"
        class="flex w-full justify-between"
      >
        <div class="flex-1">
          <div class="text-content-tertiary text-p3">Capital allocator</div>
        </div>
        <div class="flex gap-8 justify-end items-center text-right flex-1">
          <div
            v-if="!isOwnerVerified"
            class="flex gap-8 items-center py-4 px-8 rounded-8 bg-error-100 text-error-500 text-p2 w-fit"
          >
            <SvgIcon
              name="warning"
              class="!w-16 !h-16"
            />
            Unknown
          </div>
          <template v-else-if="entityName">
            <BaseAvatar
              class="icon--20"
              :label="entityName"
              :src="entityLogos"
            />
            <span class="text-p2 text-content-primary truncate">{{ entityName }}</span>
          </template>
          <div
            v-else
            class="text-p2 text-content-primary"
          >-</div>
        </div>
      </div>
      <div class="flex w-full justify-between">
        <div class="text-content-tertiary text-p3">
          Allocates into
        </div>
        <div class="flex min-w-0 flex-col items-end gap-4 text-right">
          <div class="flex min-w-0 items-center justify-end gap-6">
            <AssetAvatar
              v-if="topCollateralExposureGroup && hasLiveExposureData"
              :asset="topCollateralExposureGroup.asset"
              size="20"
            />
            <span class="text-p2 text-content-primary whitespace-nowrap">
              {{ allocationSummary }}
            </span>
          </div>
        </div>
      </div>
      <div
        v-if="isConnected"
        class="flex w-full justify-between"
      >
        <div class="flex-1">
          <div class="text-content-tertiary text-p3">In wallet</div>
        </div>
        <div class="flex gap-8 justify-end items-center text-right flex-1">
          <BaseLoadableContent
            :loading="isBalancesLoading"
            style="min-width: 70px; height: 20px"
          >
            <div class="text-p2 text-content-primary whitespace-nowrap">
              {{ prices.walletBalance }}
            </div>
          </BaseLoadableContent>
        </div>
      </div>
    </div>
  </NuxtLink>
</template>
