<script setup lang="ts">
import type { MarketGroup } from '~/entities/lend-discovery'
import { isEVault, type EVault } from '@eulerxyz/euler-v2-sdk'
import { getEulerLabelEntityLogo } from '~/entities/euler/labels'
import { useMarketGroups } from '~/composables/useMarketGroups'
import { useEulerAddresses } from '~/composables/useEulerAddresses'
import { getAssetLogoUrl } from '~/composables/useTokenList'
import { getProductByVault, applyVaultOverrides, getEntitiesByVault, isVaultDeprecated } from '~/utils/eulerLabelsUtils'
import { useCustomFilters } from '~/composables/useCustomFilters'
import { useBestMaxROE } from '~/composables/useBestMaxROE'
import { useVaultSearch } from '~/composables/useVaultSearch'

import { getVaultAddress, getVaultAssetSymbol, getVaultAssetAddress } from '~/utils/discoveryCalculations'
import { buildTvlSortedOptions } from '~/utils/buildTvlSortedOptions'
import type { FilterOptionEntry } from '~/utils/buildTvlSortedOptions'

defineOptions({
  name: 'ExplorePage',
})

const { marketGroups, isResolvingTVL } = useMarketGroups()
const { getBestMaxROE } = useBestMaxROE(marketGroups)
const { isEVaultUpdating, isEarnUpdating, isSecuritizeUpdating, isEscrowUpdating } = useVaults()
const { chainId } = useEulerAddresses()
const { entities } = useEulerLabels()
const { enableEntityBranding } = useDeployConfig()

const { searchQuery, matchesSearch, clearSearch } = useVaultSearch<MarketGroup>(group => [
  group.name,
  group.curator?.name,
  ...group.metrics.assetSymbols,
  ...group.vaults.flatMap((vault) => {
    const addr = isEVault(vault) ? vault.address : ''
    if (!addr) return []
    const product = applyVaultOverrides(getProductByVault(addr), addr)
    return [
      product.name,
      product.description,
      ...getEntitiesByVault(vault as EVault).map(e => e.name),
    ]
  }),
])

const selectedMarkets = ref<string[]>([])
const selectedAssets = ref<string[]>([])
const selectedRiskManagers = ref<string[]>([])
const sortBy = ref<string>('Active')
const sortDir = ref<'desc' | 'asc'>('desc')

useUrlQuerySync([
  { ref: searchQuery, default: '', queryKey: 'search' },
  { ref: sortBy, default: 'Active', queryKey: 'sort' },
  { ref: sortDir, default: 'desc', queryKey: 'dir' },
  { ref: selectedMarkets, default: [], queryKey: 'market' },
  { ref: selectedAssets, default: [], queryKey: 'asset' },
  { ref: selectedRiskManagers, default: [], queryKey: 'riskManager' },
])

const {
  customFilters,
  removeCustomFilter,
  clearCustomFilters,
  openCustomFilterModal,
  matchesCustomFilters,
} = useCustomFilters<MarketGroup>(
  [
    { key: 'bestMaxROE', label: 'Max ROE', shortLabel: 'Max ROE', unit: 'percent' },
    { key: 'totalTVL', label: 'Total supply', shortLabel: 'Total supply', unit: 'usd' },
    { key: 'totalBorrowed', label: 'Total borrowed', shortLabel: 'Total borrowed', unit: 'usd' },
    { key: 'totalAvailableLiquidity', label: 'Available liquidity', shortLabel: 'Avail. liquidity', unit: 'usd' },
  ],
  (group, metric) => {
    if (metric === 'bestMaxROE') return getBestMaxROE(group.id).value
    const val = group.metrics[metric as keyof typeof group.metrics]
    return typeof val === 'number' ? val : 0
  },
)

watch(sortBy, (newSortBy) => {
  if (newSortBy === 'Active') {
    sortDir.value = 'desc'
  }
})

watch(chainId, (newChainId, oldChainId) => {
  if (oldChainId !== undefined && newChainId !== oldChainId) {
    clearSearch()
    selectedMarkets.value = []
    selectedAssets.value = []
    selectedRiskManagers.value = []
    clearCustomFilters()
  }
})

const marketOptions = computed(() => {
  const entries: FilterOptionEntry[] = []
  for (const group of marketGroups.value) {
    if (group.source !== 'product') continue
    const seenInGroup = new Set<string>()
    for (const vault of group.vaults) {
      const addr = getVaultAddress(vault)
      if (!addr) continue
      const market = getProductByVault(addr)
      if (!market.name || seenInGroup.has(market.name)) continue
      seenInGroup.add(market.name)
      const entityName = Array.isArray(market?.entity) ? market?.entity[0] : market?.entity
      const entityObj = entityName ? entities[entityName] : null
      entries.push({ key: market.name, label: market.name, tvl: group.metrics.totalTVL, icon: entityObj?.logo ? `/entities/${entityObj.logo}` : undefined, iconFallback: entityObj?.logo ? getEulerLabelEntityLogo(entityObj.logo) : undefined })
    }
  }
  return buildTvlSortedOptions(entries)
})

const assetOptions = computed(() => {
  const seen = new Set<string>()
  const result: { label: string, value: string, icon: string }[] = []
  for (const group of marketGroups.value) {
    for (const vault of group.vaults) {
      const symbol = getVaultAssetSymbol(vault)
      if (symbol === '?' || seen.has(symbol)) continue
      seen.add(symbol)
      const assetAddr = getVaultAssetAddress(vault)
      result.push({
        label: symbol,
        value: symbol,
        icon: getAssetLogoUrl(assetAddr, symbol),
      })
    }
  }
  return result
})

const riskManagerOptions = computed(() => {
  const entries: FilterOptionEntry[] = []
  for (const group of marketGroups.value) {
    if (group.source !== 'product') continue
    const seenInGroup = new Set<string>()
    for (const vault of group.vaults) {
      if (!isEVault(vault)) continue
      for (const entity of getEntitiesByVault(vault)) {
        if (seenInGroup.has(entity.name)) continue
        seenInGroup.add(entity.name)
        entries.push({ key: entity.name, label: entity.name, tvl: group.metrics.totalTVL, icon: entity.logo ? `/entities/${entity.logo}` : undefined, iconFallback: entity.logo ? getEulerLabelEntityLogo(entity.logo) : undefined })
      }
    }
  }
  return buildTvlSortedOptions(entries)
})

const matchesMarketFilter = (group: MarketGroup): boolean => {
  if (!selectedMarkets.value.length) return true
  return group.vaults.some((vault) => {
    const addr = getVaultAddress(vault)
    if (!addr) return false
    return selectedMarkets.value.includes(getProductByVault(addr).name)
  })
}

const matchesAssetFilter = (group: MarketGroup): boolean => {
  if (!selectedAssets.value.length) return true
  return group.vaults.some(vault =>
    selectedAssets.value.includes(getVaultAssetSymbol(vault)),
  )
}

const matchesRiskManagerFilter = (group: MarketGroup): boolean => {
  if (!selectedRiskManagers.value.length) return true
  return group.vaults.some((vault) => {
    if (!isEVault(vault)) return false
    return getEntitiesByVault(vault).some(e => selectedRiskManagers.value.includes(e.name))
  })
}

const filteredMarkets = computed(() => {
  return marketGroups.value
    .filter(g => g.source === 'product')
    .filter(matchesSearch)
    .filter(matchesMarketFilter)
    .filter(matchesAssetFilter)
    .filter(matchesRiskManagerFilter)
    .filter(matchesCustomFilters)
})

const applyRecentlyAddedSort = (sorted: MarketGroup[]): MarketGroup[] => {
  return [...sorted].sort((a, b) => {
    const af = a.metrics.hasRecentlyAdded ? 1 : 0
    const bf = b.metrics.hasRecentlyAdded ? 1 : 0
    return bf - af
  })
}

const isGroupDeprecated = (group: MarketGroup): boolean => {
  return group.vaults.length > 0 && group.vaults.every((v) => {
    const addr = getVaultAddress(v)
    return addr ? isVaultDeprecated(addr) : false
  })
}

const applyDeprecatedGroupSort = (sorted: MarketGroup[]): MarketGroup[] => {
  return [...sorted].sort((a, b) => {
    const ad = isGroupDeprecated(a) ? 1 : 0
    const bd = isGroupDeprecated(b) ? 1 : 0
    return ad - bd
  })
}

const sortedMarkets = computed(() => {
  let sorted: MarketGroup[]
  switch (sortBy.value) {
    case 'Active': {
      const list = [...filteredMarkets.value]

      const maxTVL = Math.max(...list.map(g => g.metrics.totalTVL), 0)
      const maxPairCount = Math.max(...list.map(g => g.metrics.borrowableVaultCount), 1)
      const logMax = Math.log(maxPairCount + 1)

      const deprecatedRatio = (group: MarketGroup): number => {
        const total = group.vaults.length
        if (total === 0) return 0
        const deprecated = group.vaults.filter((v) => {
          const addr = getVaultAddress(v)
          return addr ? isVaultDeprecated(addr) : false
        }).length
        return deprecated / total
      }

      const scored = list.map((group) => {
        const normalizedTVL = maxTVL === 0 ? 0 : group.metrics.totalTVL / maxTVL
        const simplicity = logMax > 0 ? 1 - Math.log(group.metrics.borrowableVaultCount || 1) / logMax : 1
        const healthFactor = 1 - deprecatedRatio(group)
        const compositeScore = normalizedTVL * (1 + simplicity * 0.15) * healthFactor
        return { group, compositeScore }
      })

      scored.sort((a, b) => b.compositeScore - a.compositeScore)
      return applyDeprecatedGroupSort(applyRecentlyAddedSort(scored.map(s => s.group)))
    }
    case 'Max ROE':
      sorted = applyRecentlyAddedSort([...filteredMarkets.value].sort((a, b) =>
        getBestMaxROE(b.id).value - getBestMaxROE(a.id).value,
      ))
      break
    case 'Total Supply':
      sorted = applyRecentlyAddedSort([...filteredMarkets.value].sort((a, b) =>
        b.metrics.totalTVL - a.metrics.totalTVL,
      ))
      break
    case 'Total Borrowed':
      sorted = applyRecentlyAddedSort([...filteredMarkets.value].sort((a, b) =>
        b.metrics.totalBorrowed - a.metrics.totalBorrowed,
      ))
      break
    case 'Available Liquidity':
      sorted = applyRecentlyAddedSort([...filteredMarkets.value].sort((a, b) =>
        b.metrics.totalAvailableLiquidity - a.metrics.totalAvailableLiquidity,
      ))
      break
    default:
      sorted = applyRecentlyAddedSort([...filteredMarkets.value])
  }
  const directed = sortDir.value === 'asc' ? [...sorted].reverse() : sorted
  return applyDeprecatedGroupSort(directed)
})

const isLoading = computed(() =>
  isEVaultUpdating.value || isEarnUpdating.value || isSecuritizeUpdating.value || isEscrowUpdating.value
  || isResolvingTVL.value,
)
const { isSlow } = useSlowLoading(isLoading)
</script>

<template>
  <section class="flex flex-col min-h-[calc(100dvh-178px)]">
    <BasePageHeader
      title="Explore"
      description="Discover lending markets across Euler. Filter by asset, risk manager, or market type."
      class="mb-16"
      icon="nodes"
    />

    <div class="mb-16 -mx-16">
      <div class="flex items-center flex-wrap gap-8 px-16">
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
          :options="[
            { label: 'Active', icon: 'sparks' },
            { label: 'Max ROE', icon: 'percent' },
            { label: 'Total Supply', icon: 'lend-outline' },
            { label: 'Total Borrowed', icon: 'borrow-outline' },
            { label: 'Available Liquidity', icon: 'wallet' },
          ]"
          :disable-dir="sortBy === 'Active'"
          title="Sorting type"
        />
        <UiSelect
          v-if="enableEntityBranding"
          :key="`risk-managers-${chainId}`"
          v-model="selectedRiskManagers"
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
          :options="marketOptions"
          placeholder="Market"
          title="Market"
          modal-input-placeholder="Search market"
          icon="bank"
        />
        <UiSelect
          :key="`assets-${chainId}`"
          v-model="selectedAssets"
          :options="assetOptions"
          placeholder="Asset"
          title="Asset"
          modal-input-placeholder="Search asset"
          icon="wallet"
        />
        <UiCustomFilterChips
          :filters="customFilters"
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

      <DiscoveryMarketAccordion
        v-else-if="sortedMarkets.length"
        :markets="sortedMarkets"
      />

      <div
        v-else
        class="flex flex-col flex-1 gap-3 items-center justify-center text-content-tertiary"
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
