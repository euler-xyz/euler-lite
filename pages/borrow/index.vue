<script setup lang="ts">
import type { AnyBorrowVaultPair } from '~/types/borrow-pair'
import { getAssetUsdValue } from '~/utils/sdk-prices'
import { getProductByVault, applyVaultOverrides, getUniqueEntitiesByVaults, isVaultRecentlyAdded, isVaultDeprecated, isVaultNotExplorableBorrow } from '~/utils/eulerLabelsUtils'
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
import {
  areTokenAddressesCorrelatedByTags,
  getSupportedTokenCategoryOptions,
  normalizeTokenCategoryTags,
  toTokenCategoryFilterValue,
  tokenAddressMatchesCategoryFilter,
} from '~/utils/token-categories'
import { formatCompactUsdValue } from '~/utils/string-utils'
import { getBorrowPairSearchAddresses } from '~/utils/borrow-pair'
import { getChainLogoUrl } from '~/utils/chain-logo'
import { getChainById } from '~/entities/chainRegistry'
import { getEulerLabelsDataForChain } from '~/composables/useEulerLabels'
import type { SelectOption, SelectQuickFilter } from '~/components/ui/modals/select.types'

type AssetFilterOption = SelectOption
type AssetFilterOptions = { options: AssetFilterOption[], quickFilters: SelectQuickFilter[] }
type BorrowFilterAsset = { address: string, symbol: string, chainId: number }

const CATEGORY_FILTER_LABELS: Record<string, string> = {
  eth: 'ETH',
  btc: 'BTC',
  usd: 'USD',
}

const CATEGORY_FILTER_ORDER = ['eth', 'btc', 'usd']
const getCategoryFilterOrder = (tag: string): number => {
  const index = CATEGORY_FILTER_ORDER.indexOf(tag)
  return index === -1 ? CATEGORY_FILTER_ORDER.length : index
}

const { settings } = useUserSettings()
const enableIntrinsicApy = computed(() => settings.value.enableIntrinsicApy)
const { getSupplyRewardApy, getBorrowRewardApy, getLoopingRewardApy } = useRewardsApy()
const { getTokenCategoryTags, isLoading: isTokenListLoading } = useTokenList()

const isCorrelatedPair = (pair: AnyBorrowVaultPair) =>
  areTokenAddressesCorrelatedByTags(
    pair.collateral.asset.address,
    pair.borrow.asset.address,
    address => getTokenCategoryTags(address, pair.borrow.chainId),
  )

const getNetApy = (pair: AnyBorrowVaultPair) => {
  const baseSupplyApy = getVaultSupplyApy(pair.collateral)
  const baseBorrowApy = getVaultBorrowApy(pair.borrow)
  const supplyApy = withVaultIntrinsicApy(baseSupplyApy, pair.collateral, enableIntrinsicApy.value)
  const borrowApy = withVaultIntrinsicApy(baseBorrowApy, pair.borrow, enableIntrinsicApy.value)
  const supplyRewards = getSupplyRewardApy(pair.collateral.address, pair.collateral.chainId)
  const borrowRewards = getBorrowRewardApy(pair.borrow.address, pair.collateral.address, pair.borrow.chainId)
  const loopingRewards = getLoopingRewardApy(pair.borrow.address, pair.collateral.address, pair.borrow.chainId)
  return (supplyApy + supplyRewards) - (borrowApy - borrowRewards) + loopingRewards
}

const getSortMaxRoe = (pair: AnyBorrowVaultPair) => {
  if (!isCorrelatedPair(pair)) return Number.NEGATIVE_INFINITY

  const borrowLTV = ltvToPercent(pair.ltv.borrowLTV)
  const maxMultiplier = Math.max(1, Math.floor(100 / (100 - borrowLTV) * 100) / 100)
  const baseSupplyApy = getVaultSupplyApy(pair.collateral)
  const baseBorrowApy = getVaultBorrowApy(pair.borrow)
  const supplyApy = withVaultIntrinsicApy(baseSupplyApy, pair.collateral, enableIntrinsicApy.value)
  const borrowApy = withVaultIntrinsicApy(baseBorrowApy, pair.borrow, enableIntrinsicApy.value)
  const supplyFinal = supplyApy + getSupplyRewardApy(pair.collateral.address, pair.collateral.chainId)
  const borrowFinal = borrowApy - getBorrowRewardApy(pair.borrow.address, pair.collateral.address, pair.borrow.chainId)
  const loopingRewards = getLoopingRewardApy(pair.borrow.address, pair.collateral.address, pair.borrow.chainId)
  return supplyFinal + (maxMultiplier - 1) * (supplyFinal - borrowFinal) + loopingRewards
}

const getActiveSortYieldScore = (pair: AnyBorrowVaultPair): number => {
  const maxRoe = getSortMaxRoe(pair)
  return Number.isFinite(maxRoe) ? maxRoe : getNetApy(pair)
}

const compareMaxRoe = (a: AnyBorrowVaultPair, b: AnyBorrowVaultPair, direction: 'desc' | 'asc' = 'desc'): number => {
  const aValue = getSortMaxRoe(a)
  const bValue = getSortMaxRoe(b)
  const aFinite = Number.isFinite(aValue)
  const bFinite = Number.isFinite(bValue)
  const directionFactor = direction === 'asc' ? -1 : 1

  if (!aFinite && !bFinite) {
    const netApyDelta = (getNetApy(b) - getNetApy(a)) * directionFactor
    if (netApyDelta !== 0) return netApyDelta

    const liquidityDelta = comparePairLiquidityDesc(a, b)
    if (liquidityDelta !== 0) return liquidityDelta

    return comparePairNameAsc(a, b)
  }

  if (!aFinite) return 1
  if (!bFinite) return -1

  const roeDelta = (bValue - aValue) * directionFactor
  if (roeDelta !== 0) return roeDelta

  const liquidityDelta = comparePairLiquidityDesc(a, b)
  if (liquidityDelta !== 0) return liquidityDelta

  return comparePairNameAsc(a, b)
}

defineOptions({
  name: 'BorrowPage',
})

const { borrowList, isEVaultUpdating, isEscrowUpdating } = useVaults()
const { chainId, selectedChainIds } = useEulerAddresses()

const isPricesReady = ref(false)
const { isReady: labelsReady } = useEulerLabels()
const { enableEntityBranding } = useDeployConfig()
const showAllLabelEntries = useShowAllLabelEntries()

const activeBorrowList = computed(() =>
  borrowList.value.filter((pair) => {
    if (!showAllLabelEntries.value && isVaultNotExplorableBorrow(pair.borrow.address, pair.borrow.chainId)) return false
    if (!showAllLabelEntries.value && isVaultNotExplorableBorrow(pair.collateral.address, pair.collateral.chainId)) return false
    if (isOpDisabled(pair.borrow, OP_BORROW)) return false
    // Securitize collateral has no EVault hook flags — only check EVault collateral.
    // Fresh-deposit needs OP_DEPOSIT, savings-sourced needs OP_TRANSFER.
    // Hide only when BOTH paths are blocked; the form guards the active path.
    if (!isSecuritizeBorrowPair(pair) && isOpDisabled(pair.collateral, OP_DEPOSIT) && isOpDisabled(pair.collateral, OP_TRANSFER)) return false
    return true
  }),
)

const { searchQuery, matchesSearch, clearSearch } = useVaultSearch<AnyBorrowVaultPair>((pair) => {
  const product = applyVaultOverrides(getProductByVault(pair.collateral.address, pair.collateral.chainId), pair.collateral.address)
  return [
    pair.collateral.asset.symbol,
    pair.collateral.asset.name,
    pair.collateral.shares.name,
    pair.borrow.asset.symbol,
    pair.borrow.asset.name,
    pair.borrow.shares.name,
    ...getBorrowPairSearchAddresses(pair),
    product.name,
    product.description,
    ...getUniqueEntitiesByVaults([pair.collateral, pair.borrow]).map(e => e.name),
  ]
})

const selectedCollateral = ref<string[]>([])
const selectedDebt = ref<string[]>([])
const selectedChains = ref<string[]>([])
const selectedMarkets = ref<string[]>([])
const selectedRiskManagers = ref<string[]>([])
const sortBy = ref<string>('Active')
const sortDir = ref<'desc' | 'asc'>('desc')
const MIN_BORROW_LIQUIDITY_USD = 1000
const defaultBorrowLiquidityFilter = {
  id: 'borrow-min-liquidity-usd',
  metric: 'liquidity',
  operator: 'gt',
  value: MIN_BORROW_LIQUIDITY_USD,
  label: `Avail. liquidity > ${formatCompactUsdValue(MIN_BORROW_LIQUIDITY_USD)}`,
  tone: 'neutral',
  includeWhenValueUnavailable: true,
} as const

useUrlQuerySync([
  { ref: searchQuery, default: '', queryKey: 'search' },
  { ref: sortBy, default: 'Active', queryKey: 'sort' },
  { ref: sortDir, default: 'desc', queryKey: 'dir' },
  { ref: selectedChains, default: [], queryKey: 'chain' },
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
const pairLiquidityUsd = ref<Map<string, number | undefined>>(new Map())
const pairBorrowedUsd = ref<Map<string, number | undefined>>(new Map())
let priceLoadId = 0

// Helper to create a unique key for a borrow pair
const getPairKey = (pair: AnyBorrowVaultPair) => `${pair.collateral.chainId}-${pair.borrow.chainId}-${pair.collateral.address}-${pair.borrow.address}`

const areBorrowPriceValuesReady = computed(() => {
  if (!isPricesReady.value) return false

  const liquidityValues = pairLiquidityUsd.value
  const borrowedValues = pairBorrowedUsd.value

  return activeBorrowList.value.every((pair) => {
    const key = getPairKey(pair)
    return liquidityValues.has(key) && borrowedValues.has(key)
  })
})

const isLoading = computed(() =>
  isEVaultUpdating.value
  || isEscrowUpdating.value
  || isTokenListLoading.value
  || !labelsReady.value
  || !areBorrowPriceValuesReady.value,
)
const { isSlow } = useSlowLoading(isLoading)

const getPairSortName = (pair: AnyBorrowVaultPair): string =>
  `${pair.collateral.asset.symbol}/${pair.borrow.asset.symbol}`

const comparePairLiquidityDesc = (a: AnyBorrowVaultPair, b: AnyBorrowVaultPair): number =>
  (pairLiquidityUsd.value.get(getPairKey(b)) ?? 0) - (pairLiquidityUsd.value.get(getPairKey(a)) ?? 0)

const comparePairNameAsc = (a: AnyBorrowVaultPair, b: AnyBorrowVaultPair): number => {
  const nameDelta = getPairSortName(a).localeCompare(getPairSortName(b))
  if (nameDelta !== 0) return nameDelta
  return getPairKey(a).localeCompare(getPairKey(b))
}

// Fetch USD values for all borrow pairs. Debounced to collapse the
// bursts of registry updates streamed during loadVaults's RPC refresh
// (each batch causes borrowList to re-derive) into a single pass —
// this is the most expensive price-fetch watcher in the app because
// pair count is combinatorial in collaterals × borrow vaults.
const fetchBorrowPrices = useDebounceFn(async () => {
  const loadId = ++priceLoadId
  const pairs = borrowList.value
  if (!pairs.length) {
    isPricesReady.value = true
    return
  }

  try {
    const liquidityValues = new Map<string, number | undefined>()
    const borrowedValues = new Map<string, number | undefined>()
    await Promise.all(
      pairs.map(async (pair) => {
        const key = getPairKey(pair)
        const [liquidity, borrowed] = await Promise.all([
          Promise.resolve()
            .then(() => getAssetUsdValue(getVaultAvailableLiquidity(pair.borrow), pair.borrow, 'on-chain'))
            .catch(() => undefined),
          Promise.resolve()
            .then(() => getAssetUsdValue(pair.borrow.totalBorrowed, pair.borrow, 'on-chain'))
            .catch(() => undefined),
        ])
        liquidityValues.set(key, liquidity)
        borrowedValues.set(key, borrowed)
      }),
    )
    if (loadId !== priceLoadId) return
    pairLiquidityUsd.value = liquidityValues
    pairBorrowedUsd.value = borrowedValues
  }
  finally {
    if (loadId === priceLoadId) {
      isPricesReady.value = true
    }
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
  const borrowRewards = getBorrowRewardApy(pair.borrow.address, pair.collateral.address, pair.borrow.chainId)
  return borrowApy - borrowRewards
}

const getPairSupplyApy = (pair: AnyBorrowVaultPair): number => {
  const baseSupplyApy = getVaultSupplyApy(pair.collateral)
  const supplyApy = withVaultIntrinsicApy(baseSupplyApy, pair.collateral, enableIntrinsicApy.value)
  const supplyRewards = getSupplyRewardApy(pair.collateral.address, pair.collateral.chainId)
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
      case 'liquidity': return pairLiquidityUsd.value.get(key)
      case 'totalBorrowed': return pairBorrowedUsd.value.get(key)
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
  [defaultBorrowLiquidityFilter],
)

watch(chainId, (newChainId, oldChainId) => {
  if (oldChainId !== undefined && newChainId !== oldChainId) {
    clearSearch()
    selectedChains.value = []
    selectedCollateral.value = []
    selectedDebt.value = []
    selectedMarkets.value = []
    selectedRiskManagers.value = []
    clearCustomFilters()
  }
})

const buildAssetFilterOptions = (
  assets: BorrowFilterAsset[],
): AssetFilterOptions => {
  const seenAssets = new Set<string>()
  const availableCategoryTags = new Set<string>()
  const assetOptions: AssetFilterOption[] = []

  for (const asset of assets) {
    const value = `${asset.chainId}:${asset.address}`
    const categoryTags = normalizeTokenCategoryTags(getTokenCategoryTags(asset.address, asset.chainId))

    for (const tag of categoryTags) {
      availableCategoryTags.add(tag)
    }

    if (seenAssets.has(value)) continue
    seenAssets.add(value)
    assetOptions.push({
      label: asset.symbol,
      value,
      icon: getAssetLogoUrl(asset.address, asset.symbol, asset.chainId),
      quickFilterValues: categoryTags.map(toTokenCategoryFilterValue),
    })
  }

  const quickFilters = getSupportedTokenCategoryOptions()
    .filter(({ tag }) => availableCategoryTags.has(tag))
    .sort((a, b) => getCategoryFilterOrder(a.tag) - getCategoryFilterOrder(b.tag) || a.label.localeCompare(b.label))
    .map(({ tag, label }) => ({
      label: CATEGORY_FILTER_LABELS[tag] ?? label,
      value: toTokenCategoryFilterValue(tag),
    }))

  return { options: assetOptions, quickFilters }
}

const matchesAssetFilterSelection = (
  asset: BorrowFilterAsset,
  selected: readonly string[],
): boolean => {
  if (!selected.length) return true

  const assetValue = `${asset.chainId}:${asset.address}`
  return selected.some(selectedValue =>
    selectedValue === assetValue || tokenAddressMatchesCategoryFilter(asset.address, selectedValue, address => getTokenCategoryTags(address, asset.chainId)),
  )
}

watch(selectedChainIds, (chainIds) => {
  const allowed = new Set(chainIds.map(String))
  selectedChains.value = selectedChains.value.filter(id => allowed.has(id))
})

const collateralAssetOptions = computed(() => {
  return buildAssetFilterOptions(activeBorrowList.value.map(pair => ({
    ...pair.collateral.asset,
    chainId: pair.collateral.chainId,
  })))
})

const debtAssetOptions = computed(() => {
  return buildAssetFilterOptions(activeBorrowList.value.map(pair => ({
    ...pair.borrow.asset,
    chainId: pair.borrow.chainId,
  })))
})

const marketOptions = computed(() => {
  const counted = new Set<string>()
  return buildTvlSortedOptions(activeBorrowList.value.flatMap((pair) => {
    const market = getProductByVault(pair.collateral.address, pair.collateral.chainId)
    if (!market.name) return []
    const dedupKey = `${market.name}:${pair.borrow.chainId}:${pair.borrow.address}`
    const pairKey = getPairKey(pair)
    const tvl = counted.has(dedupKey) ? 0 : (pairLiquidityUsd.value.get(pairKey) ?? 0) + (pairBorrowedUsd.value.get(pairKey) ?? 0)
    counted.add(dedupKey)
    const entityName = Array.isArray(market?.entity) ? market?.entity[0] : market?.entity
    const entityObj = entityName ? getEulerLabelsDataForChain(pair.collateral.chainId).entities[entityName] : null
    return [{ key: `${pair.collateral.chainId}:${market.name}`, label: market.name, tvl, icon: entityObj?.logo ? `/entities/${entityObj.logo}` : undefined, iconFallback: entityObj?.logo ? getEulerLabelEntityLogo(entityObj.logo) : undefined }]
  }))
})

const riskManagerOptions = computed(() => {
  const counted = new Set<string>()
  return buildTvlSortedOptions(activeBorrowList.value.flatMap((pair) => {
    const pairKey = getPairKey(pair)
    const pairTvl = (pairLiquidityUsd.value.get(pairKey) ?? 0) + (pairBorrowedUsd.value.get(pairKey) ?? 0)
    return getUniqueEntitiesByVaults([pair.collateral, pair.borrow]).map((entity) => {
      const dedupKey = `${entity.name}:${pair.borrow.chainId}:${pair.borrow.address}`
      const tvl = counted.has(dedupKey) ? 0 : pairTvl
      counted.add(dedupKey)
      return { key: entity.name, label: entity.name, tvl, icon: entity.logo ? `/entities/${entity.logo}` : undefined, iconFallback: entity.logo ? getEulerLabelEntityLogo(entity.logo) : undefined }
    })
  }))
})

const chainOptions = computed(() =>
  selectedChainIds.value.map(id => ({
    label: getChainById(id)?.name ?? String(id),
    value: String(id),
    icon: getChainLogoUrl(id),
  })),
)

const filteredBorrowList = computed(() => {
  return activeBorrowList.value
    .filter(matchesSearch)
    .filter(pair =>
      selectedChains.value.length ? selectedChains.value.includes(String(pair.borrow.chainId)) : true,
    )
    .filter(pair =>
      selectedCollateral.value.length || selectedDebt.value.length
        ? (matchesAssetFilterSelection({ ...pair.collateral.asset, chainId: pair.collateral.chainId }, selectedCollateral.value)
          && matchesAssetFilterSelection({ ...pair.borrow.asset, chainId: pair.borrow.chainId }, selectedDebt.value))
        : true,
    )
    .filter(pair => selectedMarkets.value.length ? selectedMarkets.value.includes(`${pair.collateral.chainId}:${getProductByVault(pair.collateral.address, pair.collateral.chainId).name}`) : true)
    .filter(pair => selectedRiskManagers.value.length
      ? getUniqueEntitiesByVaults([pair.collateral, pair.borrow]).some(e => selectedRiskManagers.value.includes(e.name))
      : true)
    .filter(matchesCustomFilters)
})

const isPairRecentlyAdded = (pair: AnyBorrowVaultPair) =>
  isVaultRecentlyAdded(pair.collateral.address, pair.collateral.chainId) || isVaultRecentlyAdded(pair.borrow.address, pair.borrow.chainId)

const applyRecentlyAddedPairSort = (sorted: AnyBorrowVaultPair[]): AnyBorrowVaultPair[] => {
  return [...sorted].sort((a, b) => {
    return compareRecentlyAddedPairBoost(a, b)
  })
}

const compareRecentlyAddedPairBoost = (a: AnyBorrowVaultPair, b: AnyBorrowVaultPair): number =>
  compareRecentlyAddedBoost(
    isPairRecentlyAdded(a),
    pairLiquidityUsd.value.get(getPairKey(a)) ?? 0,
    isPairRecentlyAdded(b),
    pairLiquidityUsd.value.get(getPairKey(b)) ?? 0,
  )

const applyDeprecatedPairSort = (sorted: AnyBorrowVaultPair[]): AnyBorrowVaultPair[] => {
  return [...sorted].sort((a, b) => {
    const ad = (isVaultDeprecated(a.borrow.address, a.borrow.chainId) || isVaultDeprecated(a.collateral.address, a.collateral.chainId)) ? 1 : 0
    const bd = (isVaultDeprecated(b.borrow.address, b.borrow.chainId) || isVaultDeprecated(b.collateral.address, b.collateral.chainId)) ? 1 : 0
    return ad - bd
  })
}

const sortedBorrowList = computed(() => {
  let sorted: AnyBorrowVaultPair[]
  switch (sortBy.value) {
    case 'Active': {
      const list = [...filteredBorrowList.value]

      const scores = list.map((pair) => {
        const yieldScore = getActiveSortYieldScore(pair)
        const liquidityUsd = pairLiquidityUsd.value.get(getPairKey(pair)) ?? 0
        return { pair, yieldScore, liquidityUsd }
      })

      const maxYieldScore = Math.max(...scores.map(s => s.yieldScore), 0)
      const maxLiquidity = Math.max(...scores.map(s => s.liquidityUsd), 0)

      const scored = scores.map(({ pair, yieldScore, liquidityUsd }) => {
        const normalizedYield = maxYieldScore === 0 ? 0 : yieldScore / maxYieldScore
        const normalizedLiquidity = maxLiquidity === 0 ? 0 : liquidityUsd / maxLiquidity
        const yieldBucket = yieldScore >= 0 ? 0 : 1
        const compositeScore = normalizedYield * normalizedLiquidity
        return { pair, yieldBucket, compositeScore }
      })

      scored.sort((a, b) => {
        if (a.yieldBucket !== b.yieldBucket) return a.yieldBucket - b.yieldBucket

        const scoreDelta = b.compositeScore - a.compositeScore
        if (scoreDelta !== 0) return scoreDelta

        const recentlyAddedDelta = compareRecentlyAddedPairBoost(a.pair, b.pair)
        if (recentlyAddedDelta !== 0) return recentlyAddedDelta

        const liquidityDelta = comparePairLiquidityDesc(a.pair, b.pair)
        if (liquidityDelta !== 0) return liquidityDelta

        return comparePairNameAsc(a.pair, b.pair)
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
        return getPairBorrowApy(a) - getPairBorrowApy(b)
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
      sorted = [...filteredBorrowList.value].sort((a: AnyBorrowVaultPair, b: AnyBorrowVaultPair) => {
        return compareMaxRoe(a, b, sortDir.value)
      })
      return applyDeprecatedPairSort(sorted)
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

const hasDefaultBorrowLiquidityFilter = computed(() =>
  customFilters.value.some(filter => filter.id === defaultBorrowLiquidityFilter.id),
)
const hasClearableFilters = computed(() =>
  searchQuery.value.trim().length > 0
  || selectedCollateral.value.length > 0
  || selectedDebt.value.length > 0
  || selectedMarkets.value.length > 0
  || selectedRiskManagers.value.length > 0
  || customFilters.value.some(filter => filter.id !== defaultBorrowLiquidityFilter.id),
)
const hasBorrowMarkets = computed(() => activeBorrowList.value.length > 0)
const emptyStateTitle = computed(() => hasClearableFilters.value || hasBorrowMarkets.value ? 'No borrow markets found' : 'No borrow markets yet')
const emptyStateDescription = computed(() => {
  if (hasClearableFilters.value) return 'Try clearing search or filters to uncover more borrow pairs.'
  if (hasDefaultBorrowLiquidityFilter.value && hasBorrowMarkets.value) return 'No borrow pairs match the visible filters.'
  return 'No borrow markets are available on this network yet.'
})

const clearBorrowFilters = () => {
  clearSearch()
  selectedCollateral.value = []
  selectedDebt.value = []
  selectedMarkets.value = []
  selectedRiskManagers.value = []
  clearCustomFilters()
}
</script>

<template>
  <section class="flex flex-col min-h-[calc(100dvh-178px)]">
    <div class="mb-16 flex items-start justify-between gap-16 mobile:flex-col">
      <BasePageHeader
        title="Borrow/Multiply"
        description="Borrow against your assets in isolated lending markets."
      />
    </div>

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
          :key="`chains-${selectedChainIds.join('-')}`"
          v-model="selectedChains"
          class="shrink-0 mobile:flex-1 mobile:basis-[calc(50%-4px)]"
          :options="chainOptions"
          placeholder="Chain"
          title="Chain"
          modal-input-placeholder="Search chain"
          icon="globe"
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
          :options="collateralAssetOptions.options"
          :quick-filters="collateralAssetOptions.quickFilters"
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
          :options="debtAssetOptions.options"
          :quick-filters="debtAssetOptions.quickFilters"
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

      <UiEmptyState
        v-else
        class="flex-1"
        icon="borrow-outline"
        :title="emptyStateTitle"
        :description="emptyStateDescription"
      >
        <template
          v-if="hasClearableFilters"
          #action
        >
          <UiButton
            variant="primary-stroke"
            size="small"
            @click="clearBorrowFilters"
          >
            Clear filters
          </UiButton>
        </template>
      </UiEmptyState>
    </div>
  </section>
</template>
