<script setup lang="ts">
import type { AnyBorrowVaultPair } from '~/types/borrow-pair'
import { getAssetUsdValueOrZero } from '~/utils/sdk-prices'
import { getProductByVault, applyVaultOverrides, getEntitiesByVault, isVaultRecentlyAdded, isVaultDeprecated, isVaultNotExplorableBorrow } from '~/utils/eulerLabelsUtils'
import { getEulerLabelEntityLogo } from '~/entities/euler/labels'
import { useCustomFilters } from '~/composables/useCustomFilters'
import { useVaultSearch } from '~/composables/useVaultSearch'
import { isOpDisabled, OP_BORROW, OP_DEPOSIT, OP_TRANSFER } from '~/utils/vault-hooks'
import { buildTvlSortedOptions } from '~/utils/buildTvlSortedOptions'
import { DEBOUNCE_LIST_PRICE_FETCH_MS } from '~/entities/tuning-constants'
import { isSecuritizeBorrowPair } from '~/types/borrow-pair'
import { useVaults } from '~/composables/useVaults'
import { useEulerAddresses } from '~/composables/useEulerAddresses'
import { getAssetLogoUrl } from '~/composables/useTokenList'
import { getVaultAvailableLiquidity, getVaultUtilization } from '~/utils/vault-display'
import { withVaultIntrinsicApy } from '~/utils/vault-intrinsic-apy'
import { compareRecentlyAddedBoost } from '~/utils/recentlyAddedSort'

const { settings } = useUserSettings()
const enableIntrinsicApy = computed(() => settings.value.enableIntrinsicApy)
const { getSupplyRewardApy, getBorrowRewardApy, getLoopingRewardApy } = useRewardsApy()

const getNetApy = (pair: AnyBorrowVaultPair) => {
  const baseSupplyApy = getVaultSupplyApy(pair.collateral)
  const baseBorrowApy = getVaultBorrowApy(pair.borrow)
  const supplyApy = withVaultIntrinsicApy(baseSupplyApy, pair.collateral, enableIntrinsicApy.value)
  const borrowApy = withVaultIntrinsicApy(baseBorrowApy, pair.borrow, enableIntrinsicApy.value)
  const supplyRewards = getSupplyRewardApy(pair.collateral.address)
  const borrowRewards = getBorrowRewardApy(pair.borrow.address, pair.collateral.address)
  const loopingRewards = getLoopingRewardApy(pair.borrow.address, pair.collateral.address)
  return (supplyApy + supplyRewards) - (borrowApy - borrowRewards) + loopingRewards
}

const getSortMaxRoe = (pair: AnyBorrowVaultPair) => {
  const borrowLTV = ltvToPercent(pair.ltv.borrowLTV)
  const maxMultiplier = Math.max(1, Math.floor(100 / (100 - borrowLTV) * 100) / 100)
  const baseSupplyApy = getVaultSupplyApy(pair.collateral)
  const baseBorrowApy = getVaultBorrowApy(pair.borrow)
  const supplyApy = withVaultIntrinsicApy(baseSupplyApy, pair.collateral, enableIntrinsicApy.value)
  const borrowApy = withVaultIntrinsicApy(baseBorrowApy, pair.borrow, enableIntrinsicApy.value)
  const supplyFinal = supplyApy + getSupplyRewardApy(pair.collateral.address)
  const borrowFinal = borrowApy - getBorrowRewardApy(pair.borrow.address, pair.collateral.address)
  const loopingRewards = getLoopingRewardApy(pair.borrow.address, pair.collateral.address)
  return supplyFinal + (maxMultiplier - 1) * (supplyFinal - borrowFinal) + loopingRewards
}

defineOptions({
  name: 'BorrowPage',
})

const { borrowList, isEVaultUpdating, isEscrowUpdating } = useVaults()
const { chainId } = useEulerAddresses()

const isPricesReady = ref(false)
const { entities, isReady: labelsReady } = useEulerLabels()
const isLoading = computed(() => isEVaultUpdating.value || isEscrowUpdating.value || !labelsReady.value || !isPricesReady.value)
const { isSlow } = useSlowLoading(isLoading)
const { enableEntityBranding } = useDeployConfig()
const showAllLabelEntries = useShowAllLabelEntries()

const activeBorrowList = computed(() =>
  borrowList.value.filter((pair) => {
    if (!showAllLabelEntries.value && isVaultNotExplorableBorrow(pair.borrow.address)) return false
    if (!showAllLabelEntries.value && isVaultNotExplorableBorrow(pair.collateral.address)) return false
    if (isOpDisabled(pair.borrow, OP_BORROW)) return false
    // Securitize collateral has no EVault hook flags — only check EVault collateral.
    // Fresh-deposit needs OP_DEPOSIT, savings-sourced needs OP_TRANSFER.
    // Hide only when BOTH paths are blocked; the form guards the active path.
    if (!isSecuritizeBorrowPair(pair) && isOpDisabled(pair.collateral, OP_DEPOSIT) && isOpDisabled(pair.collateral, OP_TRANSFER)) return false
    return true
  }),
)

const { searchQuery, matchesSearch, clearSearch } = useVaultSearch<AnyBorrowVaultPair>((pair) => {
  const product = applyVaultOverrides(getProductByVault(pair.collateral.address), pair.collateral.address)
  return [
    pair.collateral.asset.symbol,
    pair.collateral.asset.name,
    pair.collateral.shares.name,
    pair.borrow.asset.symbol,
    pair.borrow.asset.name,
    pair.borrow.shares.name,
    product.name,
    product.description,
    ...getEntitiesByVault(pair.borrow).map(e => e.name),
  ]
})

const selectedCollateral = ref<string[]>([])
const selectedDebt = ref<string[]>([])
const selectedMarkets = ref<string[]>([])
const selectedRiskManagers = ref<string[]>([])
const sortBy = ref<string>('Active')
const sortDir = ref<'desc' | 'asc'>('desc')

useUrlQuerySync([
  { ref: searchQuery, default: '', queryKey: 'search' },
  { ref: sortBy, default: 'Active', queryKey: 'sort' },
  { ref: sortDir, default: 'desc', queryKey: 'dir' },
  { ref: selectedCollateral, default: [], queryKey: 'collateral' },
  { ref: selectedDebt, default: [], queryKey: 'debt' },
  { ref: selectedMarkets, default: [], queryKey: 'market' },
  { ref: selectedRiskManagers, default: [], queryKey: 'riskManager' },
])

watch(sortBy, (newSortBy) => {
  if (newSortBy === 'Active') {
    sortDir.value = 'desc'
  }
})

// Cache for USD values used in sorting (keyed by pair identifier: collateral+borrow address)
const pairLiquidityUsd = ref<Map<string, number>>(new Map())
const pairBorrowedUsd = ref<Map<string, number>>(new Map())

// Helper to create a unique key for a borrow pair
const getPairKey = (pair: AnyBorrowVaultPair) => `${pair.collateral.address}-${pair.borrow.address}`

// Fetch USD values for all borrow pairs. Debounced to collapse the
// bursts of registry updates streamed during loadVaults's RPC refresh
// (each batch causes borrowList to re-derive) into a single pass —
// this is the most expensive price-fetch watcher in the app because
// pair count is combinatorial in collaterals × borrow vaults.
const fetchBorrowPrices = useDebounceFn(async () => {
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
          getAssetUsdValueOrZero(getVaultAvailableLiquidity(pair.borrow), pair.borrow, 'on-chain'),
          getAssetUsdValueOrZero(pair.borrow.totalBorrowed, pair.borrow, 'on-chain'),
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
}, DEBOUNCE_LIST_PRICE_FETCH_MS)

// Pause price fetches while the page is in keep-alive but not visible. The
// borrow page is included in app.vue's keepalive list, so it keeps running
// watchEffects when the user navigates away. Deferring the refetch until
// the user returns removes a major source of main-thread contention
// during chain switches, which otherwise fan out to every keep-alive
// page's price watchEffect at once.
const isActive = ref(true)
onActivated(() => {
  isActive.value = true
})
onDeactivated(() => {
  isActive.value = false
})

watchEffect(() => {
  void borrowList.value
  if (!isActive.value) return
  fetchBorrowPrices()
})

const getPairBorrowApy = (pair: AnyBorrowVaultPair): number => {
  const baseBorrowApy = getVaultBorrowApy(pair.borrow)
  const borrowApy = withVaultIntrinsicApy(baseBorrowApy, pair.borrow, enableIntrinsicApy.value)
  const borrowRewards = getBorrowRewardApy(pair.borrow.address, pair.collateral.address)
  return borrowApy - borrowRewards
}

const getPairSupplyApy = (pair: AnyBorrowVaultPair): number => {
  const baseSupplyApy = getVaultSupplyApy(pair.collateral)
  const supplyApy = withVaultIntrinsicApy(baseSupplyApy, pair.collateral, enableIntrinsicApy.value)
  const supplyRewards = getSupplyRewardApy(pair.collateral.address)
  return supplyApy + supplyRewards
}

const getPairMaxLtv = (pair: AnyBorrowVaultPair): number => {
  return ltvToPercent(pair.ltv.borrowLTV)
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
    { key: 'supplyApy', label: 'Supply APY', shortLabel: 'Supply APY', unit: 'percent' },
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
      case 'supplyApy': return getPairSupplyApy(pair)
      case 'borrowApy': return getPairBorrowApy(pair)
      case 'netApy': return getNetApy(pair)
      case 'maxRoe': return getSortMaxRoe(pair)
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
  const counted = new Set<string>()
  return buildTvlSortedOptions(activeBorrowList.value.flatMap((pair) => {
    const market = getProductByVault(pair.collateral.address)
    if (!market.name) return []
    const dedupKey = `${market.name}:${pair.borrow.address}`
    const pairKey = getPairKey(pair)
    const tvl = counted.has(dedupKey) ? 0 : (pairLiquidityUsd.value.get(pairKey) ?? 0) + (pairBorrowedUsd.value.get(pairKey) ?? 0)
    counted.add(dedupKey)
    const entityName = Array.isArray(market?.entity) ? market?.entity[0] : market?.entity
    const entityObj = entityName ? entities[entityName] : null
    return [{ key: market.name, label: market.name, tvl, icon: entityObj?.logo ? `/entities/${entityObj.logo}` : undefined, iconFallback: entityObj?.logo ? getEulerLabelEntityLogo(entityObj.logo) : undefined }]
  }))
})

const riskManagerOptions = computed(() => {
  const counted = new Set<string>()
  return buildTvlSortedOptions(activeBorrowList.value.flatMap((pair) => {
    const pairKey = getPairKey(pair)
    const pairTvl = (pairLiquidityUsd.value.get(pairKey) ?? 0) + (pairBorrowedUsd.value.get(pairKey) ?? 0)
    return getEntitiesByVault(pair.borrow).map((entity) => {
      const dedupKey = `${entity.name}:${pair.borrow.address}`
      const tvl = counted.has(dedupKey) ? 0 : pairTvl
      counted.add(dedupKey)
      return { key: entity.name, label: entity.name, tvl, icon: entity.logo ? `/entities/${entity.logo}` : undefined, iconFallback: entity.logo ? getEulerLabelEntityLogo(entity.logo) : undefined }
    })
  }))
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

const isPairRecentlyAdded = (pair: AnyBorrowVaultPair) =>
  isVaultRecentlyAdded(pair.collateral.address) || isVaultRecentlyAdded(pair.borrow.address)

const applyRecentlyAddedPairSort = (sorted: AnyBorrowVaultPair[]): AnyBorrowVaultPair[] => {
  return [...sorted].sort((a, b) => {
    return compareRecentlyAddedBoost(
      isPairRecentlyAdded(a),
      pairLiquidityUsd.value.get(getPairKey(a)) ?? 0,
      isPairRecentlyAdded(b),
      pairLiquidityUsd.value.get(getPairKey(b)) ?? 0,
    )
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
    case 'Active': {
      const list = [...filteredBorrowList.value]

      const scores = list.map((pair) => {
        const maxRoe = getSortMaxRoe(pair)
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

      // Active sort ignores direction toggle
      return applyDeprecatedPairSort(applyRecentlyAddedPairSort(scored.map(s => s.pair)))
    }
    case 'Liquidity':
      sorted = applyRecentlyAddedPairSort([...filteredBorrowList.value].sort((a: AnyBorrowVaultPair, b: AnyBorrowVaultPair) => {
        const aValue = pairLiquidityUsd.value.get(getPairKey(a)) ?? 0
        const bValue = pairLiquidityUsd.value.get(getPairKey(b)) ?? 0
        return bValue - aValue
      }))
      break
    case 'Borrow APY':
      sorted = applyRecentlyAddedPairSort([...filteredBorrowList.value].sort((a: AnyBorrowVaultPair, b: AnyBorrowVaultPair) => {
        return Number(getVaultBorrowApy(a.borrow)) - Number(getVaultBorrowApy(b.borrow))
      }))
      break
    case 'Supply APY':
      sorted = applyRecentlyAddedPairSort([...filteredBorrowList.value].sort((a: AnyBorrowVaultPair, b: AnyBorrowVaultPair) => {
        return getPairSupplyApy(b) - getPairSupplyApy(a)
      }))
      break
    case 'Utilization':
      sorted = applyRecentlyAddedPairSort([...filteredBorrowList.value].sort((a: AnyBorrowVaultPair, b: AnyBorrowVaultPair) => {
        return getVaultUtilization(b.borrow) - getVaultUtilization(a.borrow)
      }))
      break
    case 'Total Borrowed':
      sorted = applyRecentlyAddedPairSort([...filteredBorrowList.value].sort((a: AnyBorrowVaultPair, b: AnyBorrowVaultPair) => {
        const aValue = pairBorrowedUsd.value.get(getPairKey(a)) ?? 0
        const bValue = pairBorrowedUsd.value.get(getPairKey(b)) ?? 0
        return bValue - aValue
      }))
      break
    case 'Max ROE':
      sorted = applyRecentlyAddedPairSort([...filteredBorrowList.value].sort((a: AnyBorrowVaultPair, b: AnyBorrowVaultPair) => {
        return getSortMaxRoe(b) - getSortMaxRoe(a)
      }))
      break
    case 'Net APY':
      sorted = applyRecentlyAddedPairSort([...filteredBorrowList.value].sort((a: AnyBorrowVaultPair, b: AnyBorrowVaultPair) => {
        return getNetApy(b) - getNetApy(a)
      }))
      break
    default:
      sorted = applyRecentlyAddedPairSort([...filteredBorrowList.value])
  }
  const directed = sortDir.value === 'asc' ? [...sorted].reverse() : sorted
  return applyDeprecatedPairSort(directed)
})
</script>

<template>
  <section class="flex flex-col min-h-[calc(100dvh-178px)]">
    <BasePageHeader
      title="Borrow/Multiply"
      description="Borrow against your assets in isolated lending markets."
      class="mb-16"
    />

    <div class="mb-16">
      <div class="flex justify-start items-center w-full gap-8 flex-wrap">
        <UiInput
          v-model="searchQuery"
          placeholder="Search by asset, market, curator..."
          icon="search"
          clearable
          compact
          class="flex-1 min-w-[200px] mobile:basis-full"
        />
        <VaultSortButton
          v-model="sortBy"
          v-model:dir="sortDir"
          class="shrink-0 mobile:flex-1 mobile:basis-[calc(50%-4px)]"
          :options="[
            { label: 'Active', icon: 'sparks' },
            { label: 'Liquidity', icon: 'wallet' },
            { label: 'Total Borrowed', icon: 'borrow-outline' },
            { label: 'Utilization', icon: 'pulse' },
            { label: 'Supply APY', icon: 'percent' },
            { label: 'Borrow APY', icon: 'percent' },
            { label: 'Net APY', icon: 'percent' },
            { label: 'Max ROE', icon: 'percent' },
          ]"
          :disable-dir="sortBy === 'Active'"
          title="Sorting type"
        />
        <UiSelect
          v-if="enableEntityBranding"
          :key="`risk-managers-${chainId}`"
          v-model="selectedRiskManagers"
          class="shrink-0 mobile:flex-1 mobile:basis-[calc(50%-4px)]"
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
          class="shrink-0 mobile:flex-1 mobile:basis-[calc(50%-4px)]"
          :options="marketOptions"
          placeholder="Market"
          title="Market"
          modal-input-placeholder="Search market"
          icon="bank"
        />
        <UiSelect
          :key="`collateral-${chainId}`"
          v-model="selectedCollateral"
          class="shrink-0 mobile:flex-1 mobile:basis-[calc(50%-4px)]"
          :options="collateralAssetOptions"
          placeholder="Collateral asset"
          title="Collateral asset"
          modal-input-placeholder="Search asset"
          icon="wallet"
          show-selected-options
        />
        <UiSelect
          :key="`debt-${chainId}`"
          v-model="selectedDebt"
          class="shrink-0 mobile:flex-1 mobile:basis-[calc(50%-4px)]"
          :options="debtAssetOptions"
          placeholder="Debt asset"
          title="Debt asset"
          modal-input-placeholder="Search asset"
          icon="wallet"
          show-selected-options
        />
        <UiCustomFilterChips
          :filters="customFilters"
          chip-class="shrink-0"
          @remove="removeCustomFilter"
          @add="openCustomFilterModal"
        />
      </div>
    </div>

    <div class="flex flex-col flex-1">
      <div
        v-if="isLoading"
        class="flex flex-col flex-1 items-center justify-center gap-12"
      >
        <UiLoader />
        <span
          v-if="isSlow"
          class="text-p2 text-content-tertiary text-center max-w-[240px]"
        >Loading is taking longer than usual. Please check your connection.</span>
      </div>

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
