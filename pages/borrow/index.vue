<script setup lang="ts">
import { useVaults } from '~/composables/useVaults'
import { useEulerAddresses } from '~/composables/useEulerAddresses'
import { getAssetLogoUrl } from '~/composables/useTokens'
import { getVaultUtilization } from '~/entities/vault'
import type { AnyBorrowVaultPair, BorrowVaultPair } from '~/entities/vault'
import { getAssetUsdValueOrZero } from '~/services/pricing/priceProvider'
import { getProductByVault, getEntitiesByVault, isVaultFeatured, isVaultDeprecated } from '~/utils/eulerLabelsUtils'
import { getEulerLabelEntityLogo } from '~/entities/euler/labels'
import { useCustomFilters } from '~/composables/useCustomFilters'
import { useVaultSearch } from '~/composables/useVaultSearch'

const { withIntrinsicBorrowApy, withIntrinsicSupplyApy } = useIntrinsicApy()
const { getSupplyRewardApy, getBorrowRewardApy } = useRewardsApy()

const getNetApy = (pair: BorrowVaultPair) => {
  const baseSupplyApy = nanoToValue(pair.collateral.interestRateInfo?.supplyAPY || 0n, 25)
  const baseBorrowApy = nanoToValue(pair.borrow.interestRateInfo.borrowAPY, 25)
  const supplyApy = withIntrinsicSupplyApy(baseSupplyApy, pair.collateral.asset.address)
  const borrowApy = withIntrinsicBorrowApy(baseBorrowApy, pair.borrow.asset.address)
  const supplyRewards = getSupplyRewardApy(pair.collateral.address)
  const borrowRewards = getBorrowRewardApy(pair.borrow.address, pair.collateral.address)
  return (supplyApy + supplyRewards) - (borrowApy - borrowRewards)
}

const getSortMaxRoe = (pair: BorrowVaultPair) => {
  const borrowLTV = nanoToValue(pair.borrowLTV, 2)
  const maxMultiplier = Math.max(1, Math.floor(100 / (100 - borrowLTV) * 100) / 100)
  const baseSupplyApy = nanoToValue(pair.collateral.interestRateInfo?.supplyAPY || 0n, 25)
  const supplyApy = withIntrinsicSupplyApy(baseSupplyApy, pair.collateral.asset.address)
  const supplyRewards = getSupplyRewardApy(pair.collateral.address)
  const supplyApyWithRewards = supplyApy + supplyRewards
  const netApy = getNetApy(pair)
  return supplyApyWithRewards + (maxMultiplier - 1) * netApy
}

defineOptions({
  name: 'BorrowPage',
})

const { borrowList, isUpdating, isEscrowUpdating } = useVaults()
const { chainId } = useEulerAddresses()

const isPricesReady = ref(false)
const isLoading = computed(() => isUpdating.value || isEscrowUpdating.value || !isPricesReady.value)
const { enableEntityBranding } = useDeployConfig()
const { entities } = useEulerLabels()

const activeBorrowList = computed(() => borrowList.value)

const { searchQuery, matchesSearch, clearSearch } = useVaultSearch<AnyBorrowVaultPair>(pair => [
  pair.collateral.asset.symbol,
  pair.collateral.asset.name,
  pair.collateral.name,
  pair.borrow.asset.symbol,
  pair.borrow.asset.name,
  pair.borrow.name,
  getProductByVault(pair.collateral.address).name,
  getProductByVault(pair.collateral.address).description,
  ...getEntitiesByVault(pair.borrow).map(e => e.name),
])

const selectedCollateral = ref<string[]>([])
const selectedDebt = ref<string[]>([])
const selectedMarkets = ref<string[]>([])
const selectedRiskManagers = ref<string[]>([])
const sortBy = ref<string>('Recommended')
const sortDir = ref<'desc' | 'asc'>('desc')

useUrlQuerySync([
  { ref: searchQuery, default: '', queryKey: 'search' },
  { ref: sortBy, default: 'Recommended', queryKey: 'sort' },
  { ref: sortDir, default: 'desc', queryKey: 'dir' },
  { ref: selectedCollateral, default: [], queryKey: 'collateral' },
  { ref: selectedDebt, default: [], queryKey: 'debt' },
  { ref: selectedMarkets, default: [], queryKey: 'market' },
  { ref: selectedRiskManagers, default: [], queryKey: 'riskManager' },
])

watch(sortBy, (newSortBy) => {
  if (newSortBy === 'Recommended') {
    sortDir.value = 'desc'
  }
})

// Cache for USD values used in sorting (keyed by pair identifier: collateral+borrow address)
const pairLiquidityUsd = ref<Map<string, number>>(new Map())
const pairBorrowedUsd = ref<Map<string, number>>(new Map())

// Helper to create a unique key for a borrow pair
const getPairKey = (pair: AnyBorrowVaultPair) => `${pair.collateral.address}-${pair.borrow.address}`

// Fetch USD values for all borrow pairs
watchEffect(async () => {
  const pairs = borrowList.value
  if (!pairs.length) {
    isPricesReady.value = true
    return
  }

  try {
    const liquidityValues = new Map<string, number>()
    const borrowedValues = new Map<string, number>()
    await Promise.all(
      pairs.map(async (pair) => {
        const key = getPairKey(pair)
        const [liquidity, borrowed] = await Promise.all([
          getAssetUsdValueOrZero(pair.borrow.supply >= pair.borrow.borrow ? pair.borrow.supply - pair.borrow.borrow : 0n, pair.borrow, 'off-chain'),
          getAssetUsdValueOrZero(pair.borrow.borrow, pair.borrow, 'off-chain'),
        ])
        liquidityValues.set(key, liquidity)
        borrowedValues.set(key, borrowed)
      }),
    )
    pairLiquidityUsd.value = liquidityValues
    pairBorrowedUsd.value = borrowedValues
  }
  finally {
    isPricesReady.value = true
  }
})

const getPairBorrowApy = (pair: AnyBorrowVaultPair): number => {
  const baseBorrowApy = nanoToValue(pair.borrow.interestRateInfo.borrowAPY, 25)
  const borrowApy = withIntrinsicBorrowApy(baseBorrowApy, pair.borrow.asset.address)
  const borrowRewards = getBorrowRewardApy(pair.borrow.address, pair.collateral.address)
  return borrowApy - borrowRewards
}

const getPairMaxLtv = (pair: AnyBorrowVaultPair): number => {
  return nanoToValue(pair.borrowLTV, 2)
}

const getPairMaxMultiplier = (pair: AnyBorrowVaultPair): number => {
  const borrowLTV = getPairMaxLtv(pair)
  return Math.max(1, Math.floor(100 / (100 - borrowLTV) * 100) / 100)
}

const {
  customFilters,
  removeCustomFilter,
  clearCustomFilters,
  openCustomFilterModal,
  matchesCustomFilters,
} = useCustomFilters<AnyBorrowVaultPair>(
  [
    { key: 'liquidity', label: 'Available liquidity', shortLabel: 'Avail. liquidity', unit: 'usd' },
    { key: 'totalBorrowed', label: 'Total borrowed', shortLabel: 'Total borrowed', unit: 'usd' },
    { key: 'borrowApy', label: 'Borrow APY', shortLabel: 'Borrow APY', unit: 'percent' },
    { key: 'netApy', label: 'Net APY', shortLabel: 'Net APY', unit: 'percent' },
    { key: 'maxRoe', label: 'Max ROE', shortLabel: 'Max ROE', unit: 'percent' },
    { key: 'utilization', label: 'Utilization', shortLabel: 'Utilization', unit: 'percent' },
    { key: 'maxLtv', label: 'Max LTV', shortLabel: 'Max LTV', unit: 'percent' },
    { key: 'maxMultiplier', label: 'Max multiplier', shortLabel: 'Max multiplier', unit: 'multiplier' },
  ],
  (pair, metric) => {
    const key = getPairKey(pair)
    switch (metric) {
      case 'liquidity': return pairLiquidityUsd.value.get(key) ?? 0
      case 'totalBorrowed': return pairBorrowedUsd.value.get(key) ?? 0
      case 'borrowApy': return getPairBorrowApy(pair)
      case 'netApy': return 'borrowLTV' in pair ? getNetApy(pair as BorrowVaultPair) : 0
      case 'maxRoe': return 'borrowLTV' in pair ? getSortMaxRoe(pair as BorrowVaultPair) : 0
      case 'utilization': return getVaultUtilization(pair.borrow)
      case 'maxLtv': return getPairMaxLtv(pair)
      case 'maxMultiplier': return getPairMaxMultiplier(pair)
      default: return 0
    }
  },
)

watch(chainId, (newChainId, oldChainId) => {
  if (oldChainId !== undefined && newChainId !== oldChainId) {
    clearSearch()
    selectedCollateral.value = []
    selectedDebt.value = []
    selectedMarkets.value = []
    selectedRiskManagers.value = []
    clearCustomFilters()
  }
})

const collateralAssetOptions = computed(() => {
  return activeBorrowList.value
    .filter((item, idx, self) => idx === self.findIndex(t => t.collateral.asset.address === item.collateral.asset.address))
    .map(pair => ({
      label: pair.collateral.asset.symbol,
      value: pair.collateral.asset.address,
      icon: getAssetLogoUrl(pair.collateral.asset.address, pair.collateral.asset.symbol),
    }))
    .reduce((prev, curr) =>
      prev.find(vault => vault.value === curr.value) ? prev : [...prev, curr], [] as { label: string, value: string, icon: string }[],
    )
})

const debtAssetOptions = computed(() => {
  return activeBorrowList.value
    .filter((item, idx, self) => idx === self.findIndex(t => t.borrow.asset.address === item.borrow.asset.address))
    .map(pair => ({
      label: pair.borrow.asset.symbol,
      value: pair.borrow.asset.address,
      icon: getAssetLogoUrl(pair.borrow.asset.address, pair.borrow.asset.symbol),
    }))
    .reduce((prev, curr) =>
      prev.find(vault => vault.value === curr.value) ? prev : [...prev, curr], [] as { label: string, value: string, icon: string }[],
    )
})

const marketOptions = computed(() => {
  return activeBorrowList.value.reduce((result, pair) => {
    const market = getProductByVault(pair.collateral.address)
    const entityName = Array.isArray(market?.entity) ? market?.entity[0] : market?.entity
    const entityObj = entityName ? entities[entityName] : null

    if (market.name && !result.find(option => option.label === market.name)) {
      return [...result, { label: market.name, value: market.name, icon: entityObj?.logo ? `/entities/${entityObj.logo}` : undefined, iconFallback: entityObj?.logo ? getEulerLabelEntityLogo(entityObj.logo) : undefined }]
    }

    return result
  }, [] as { label: string, value: string, icon?: string, iconFallback?: string }[])
})

const riskManagerOptions = computed(() => {
  const seen = new Set<string>()
  const result: { label: string, value: string, icon?: string, iconFallback?: string }[] = []
  for (const pair of activeBorrowList.value) {
    for (const entity of getEntitiesByVault(pair.borrow)) {
      if (!seen.has(entity.name)) {
        seen.add(entity.name)
        result.push({
          label: entity.name,
          value: entity.name,
          icon: entity.logo ? `/entities/${entity.logo}` : undefined,
          iconFallback: entity.logo ? getEulerLabelEntityLogo(entity.logo) : undefined,
        })
      }
    }
  }
  return result
})

const filteredBorrowList = computed(() => {
  return activeBorrowList.value
    .filter(matchesSearch)
    .filter(pair =>
      selectedCollateral.value.length || selectedDebt.value.length
        ? ((!selectedCollateral.value.length || selectedCollateral.value.includes(pair.collateral.asset.address))
          && (!selectedDebt.value.length || selectedDebt.value.includes(pair.borrow.asset.address)))
        : true,
    )
    .filter(pair => selectedMarkets.value.length ? selectedMarkets.value.includes(getProductByVault(pair.collateral.address).name) : true)
    .filter(pair => selectedRiskManagers.value.length
      ? getEntitiesByVault(pair.borrow).some(e => selectedRiskManagers.value.includes(e.name))
      : true)
    .filter(matchesCustomFilters)
})

const isPairFeatured = (pair: AnyBorrowVaultPair) =>
  isVaultFeatured(pair.collateral.address) || isVaultFeatured(pair.borrow.address)

const applyFeaturedPairSort = (sorted: AnyBorrowVaultPair[]): AnyBorrowVaultPair[] => {
  return [...sorted].sort((a, b) => {
    const af = isPairFeatured(a) ? 1 : 0
    const bf = isPairFeatured(b) ? 1 : 0
    return bf - af
  })
}

const applyDeprecatedPairSort = (sorted: AnyBorrowVaultPair[]): AnyBorrowVaultPair[] => {
  return [...sorted].sort((a, b) => {
    const ad = (isVaultDeprecated(a.borrow.address) || isVaultDeprecated(a.collateral.address)) ? 1 : 0
    const bd = (isVaultDeprecated(b.borrow.address) || isVaultDeprecated(b.collateral.address)) ? 1 : 0
    return ad - bd
  })
}

const sortedBorrowList = computed(() => {
  let sorted: AnyBorrowVaultPair[]
  switch (sortBy.value) {
    case 'Recommended': {
      const list = [...filteredBorrowList.value]

      const scores = list.map((pair) => {
        const maxRoe = 'borrowLTV' in pair ? getSortMaxRoe(pair as BorrowVaultPair) : 0
        const liquidityUsd = pairLiquidityUsd.value.get(getPairKey(pair)) ?? 0
        return { pair, maxRoe, liquidityUsd }
      })

      const maxMaxRoe = Math.max(...scores.map(s => s.maxRoe), 0)
      const maxLiquidity = Math.max(...scores.map(s => s.liquidityUsd), 0)

      const scored = scores.map(({ pair, maxRoe, liquidityUsd }) => {
        const normalizedRoe = maxMaxRoe === 0 ? 0 : maxRoe / maxMaxRoe
        const normalizedLiquidity = maxLiquidity === 0 ? 0 : liquidityUsd / maxLiquidity
        const roeBucket = maxRoe >= 0 ? 0 : 1
        const compositeScore = normalizedRoe * normalizedLiquidity
        return { pair, roeBucket, compositeScore }
      })

      scored.sort((a, b) => {
        if (a.roeBucket !== b.roeBucket) return a.roeBucket - b.roeBucket
        return b.compositeScore - a.compositeScore
      })

      // Recommended sort ignores direction toggle
      return applyDeprecatedPairSort(applyFeaturedPairSort(scored.map(s => s.pair)))
    }
    case 'Liquidity':
      sorted = applyFeaturedPairSort([...filteredBorrowList.value].sort((a: AnyBorrowVaultPair, b: AnyBorrowVaultPair) => {
        const aValue = pairLiquidityUsd.value.get(getPairKey(a)) ?? 0
        const bValue = pairLiquidityUsd.value.get(getPairKey(b)) ?? 0
        return bValue - aValue
      }))
      break
    case 'Borrow APY':
      sorted = applyFeaturedPairSort([...filteredBorrowList.value].sort((a: AnyBorrowVaultPair, b: AnyBorrowVaultPair) => {
        return Number(a.borrow.interestRateInfo.borrowAPY) - Number(b.borrow.interestRateInfo.borrowAPY)
      }))
      break
    case 'Utilization':
      sorted = applyFeaturedPairSort([...filteredBorrowList.value].sort((a: AnyBorrowVaultPair, b: AnyBorrowVaultPair) => {
        return getVaultUtilization(b.borrow) - getVaultUtilization(a.borrow)
      }))
      break
    case 'Total Borrowed':
      sorted = applyFeaturedPairSort([...filteredBorrowList.value].sort((a: AnyBorrowVaultPair, b: AnyBorrowVaultPair) => {
        const aValue = pairBorrowedUsd.value.get(getPairKey(a)) ?? 0
        const bValue = pairBorrowedUsd.value.get(getPairKey(b)) ?? 0
        return bValue - aValue
      }))
      break
    case 'Max ROE':
      sorted = applyFeaturedPairSort([...filteredBorrowList.value].sort((a: AnyBorrowVaultPair, b: AnyBorrowVaultPair) => {
        return getSortMaxRoe(b as BorrowVaultPair) - getSortMaxRoe(a as BorrowVaultPair)
      }))
      break
    case 'Net APY':
      sorted = applyFeaturedPairSort([...filteredBorrowList.value].sort((a: AnyBorrowVaultPair, b: AnyBorrowVaultPair) => {
        return getNetApy(b as BorrowVaultPair) - getNetApy(a as BorrowVaultPair)
      }))
      break
    default:
      sorted = applyFeaturedPairSort([...filteredBorrowList.value])
  }
  const directed = sortDir.value === 'asc' ? [...sorted].reverse() : sorted
  return applyDeprecatedPairSort(directed)
})
</script>

<template>
  <section class="flex flex-col min-h-[calc(100dvh-178px)]">
    <PageHeader
      title="Borrow"
      description="Borrow against your collateral"
    >
      <template #search>
        <UiInput
          v-model="searchQuery"
          placeholder="Search"
          icon="search"
          clearable
          :full-width="false"
          class="w-[200px] shrink-0"
        />
      </template>
      <template #filters>
        <VaultSortButton
          v-model="sortBy"
          v-model:dir="sortDir"
          class="shrink-0"
          :options="['Recommended', 'Liquidity', 'Total Borrowed', 'Utilization', 'Borrow APY', 'Net APY', 'Max ROE']"
          :disable-dir="sortBy === 'Recommended'"
          title="Sorting type"
        />
        <UiSelect
          v-if="enableEntityBranding"
          :key="`risk-managers-${chainId}`"
          v-model="selectedRiskManagers"
          class="shrink-0"
          :options="riskManagerOptions"
          placeholder="Risk manager"
          title="Risk manager"
          modal-input-placeholder="Search risk manager"
          icon="shield"
        />
        <UiSelect
          v-if="enableEntityBranding"
          :key="`markets-${chainId}`"
          v-model="selectedMarkets"
          class="shrink-0"
          :options="marketOptions"
          placeholder="Market"
          title="Market"
          modal-input-placeholder="Search market"
          icon="bank"
        />
        <UiDualSelect
          :key="`assets-${chainId}`"
          v-model:collateral="selectedCollateral"
          v-model:debt="selectedDebt"
          :options-a="collateralAssetOptions"
          :options-b="debtAssetOptions"
          label-a="Collateral asset"
          label-b="Debt asset"
          placeholder="Assets"
          icon="wallet"
          class="shrink-0"
        />
        <UiCustomFilterChips
          :filters="customFilters"
          chip-class="shrink-0"
          @remove="removeCustomFilter"
          @add="openCustomFilterModal"
        />
      </template>
    </PageHeader>

    <div class="flex flex-col flex-1">
      <UiLoader
        v-if="isLoading"
        class="flex-1 self-center justify-self-center"
      />

      <VaultsBorrowList
        v-else-if="sortedBorrowList.length"
        :items="sortedBorrowList"
      />

      <div
        v-else
        class="flex flex-col flex-1 gap-3 items-center justify-center text-neutral-500"
      >
        <UiIcon
          name="search"
          class="!w-24 !h-24"
        />
        <div class="text-center max-w-[180px]">
          No markets were found by these filters
        </div>
      </div>
    </div>
  </section>
</template>
