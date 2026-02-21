<script setup lang="ts">
import { useMarketGroups } from '~/composables/useMarketGroups'
import { useEulerAddresses } from '~/composables/useEulerAddresses'
import { getAssetLogoUrl } from '~/composables/useTokens'
import { getProductByVault, getEntitiesByVault, isVaultDeprecated } from '~/utils/eulerLabelsUtils'
import { getEulerLabelEntityLogo } from '~/entities/euler/labels'
import { useCustomFilters } from '~/composables/useCustomFilters'
import { useBestNetAPY } from '~/composables/useBestNetAPY'
import { useVaultSearch } from '~/composables/useVaultSearch'
import type { MarketGroup } from '~/entities/lend-discovery'
import type { Vault } from '~/entities/vault'
import { isVaultType, getVaultAddress, getVaultAssetSymbol, getVaultAssetAddress } from '~/utils/discoveryCalculations'

defineOptions({
  name: 'ExplorePage',
})

const { marketGroups, isResolvingTVL } = useMarketGroups()
const { getBestNetAPY } = useBestNetAPY(marketGroups)
const { isUpdating, isEarnUpdating, isEscrowUpdating } = useVaults()
const { chainId } = useEulerAddresses()
const { entities } = useEulerLabels()
const { enableEntityBranding } = useDeployConfig()

const { searchQuery, matchesSearch, clearSearch } = useVaultSearch<MarketGroup>(group => [
  group.name,
  group.curator?.name,
  ...group.metrics.assetSymbols,
  ...group.vaults.flatMap((vault) => {
    const addr = isVaultType(vault) ? vault.address : ''
    if (!addr) return []
    const product = getProductByVault(addr)
    return [
      product.name,
      product.description,
      ...getEntitiesByVault(vault as Vault).map(e => e.name),
    ]
  }),
])

const selectedMarkets = ref<string[]>([])
const selectedAssets = ref<string[]>([])
const selectedRiskManagers = ref<string[]>([])
const sortBy = ref<string>('Recommended')
const sortDir = ref<'desc' | 'asc'>('desc')

useUrlQuerySync([
  { ref: searchQuery, default: '', queryKey: 'search' },
  { ref: sortBy, default: 'Recommended', queryKey: 'sort' },
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
    { key: 'bestNetAPY', label: 'Best net APY', shortLabel: 'Best net APY', unit: 'percent' },
    { key: 'totalTVL', label: 'Total supply', shortLabel: 'Total supply', unit: 'usd' },
    { key: 'totalBorrowed', label: 'Total borrowed', shortLabel: 'Total borrowed', unit: 'usd' },
    { key: 'totalAvailableLiquidity', label: 'Available liquidity', shortLabel: 'Avail. liquidity', unit: 'usd' },
  ],
  (group, metric) => {
    if (metric === 'bestNetAPY') return getBestNetAPY(group.id)
    const val = group.metrics[metric as keyof typeof group.metrics]
    return typeof val === 'number' ? val : 0
  },
)

watch(sortBy, (newSortBy) => {
  if (newSortBy === 'Recommended') {
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
  return marketGroups.value.reduce((result, group) => {
    for (const vault of group.vaults) {
      const addr = getVaultAddress(vault)
      if (!addr) continue
      const market = getProductByVault(addr)
      const entityName = Array.isArray(market?.entity) ? market?.entity[0] : market?.entity
      const entityObj = entityName ? entities[entityName] : null

      if (market.name && !result.find(option => option.label === market.name)) {
        return [...result, { label: market.name, value: market.name, icon: entityObj?.logo ? `/entities/${entityObj.logo}` : undefined, iconFallback: entityObj?.logo ? getEulerLabelEntityLogo(entityObj.logo) : undefined }]
      }
    }
    return result
  }, [] as { label: string, value: string, icon?: string, iconFallback?: string }[])
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
  const seen = new Set<string>()
  const result: { label: string, value: string, icon?: string, iconFallback?: string }[] = []
  for (const group of marketGroups.value) {
    for (const vault of group.vaults) {
      if (!isVaultType(vault)) continue
      for (const entity of getEntitiesByVault(vault)) {
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
  }
  return result
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
    if (!isVaultType(vault)) return false
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

const applyFeaturedSort = (sorted: MarketGroup[]): MarketGroup[] => {
  return [...sorted].sort((a, b) => {
    const af = a.metrics.hasFeatured ? 1 : 0
    const bf = b.metrics.hasFeatured ? 1 : 0
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
    case 'Recommended': {
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
      return applyDeprecatedGroupSort(applyFeaturedSort(scored.map(s => s.group)))
    }
    case 'Best Net APY':
      sorted = applyFeaturedSort([...filteredMarkets.value].sort((a, b) =>
        getBestNetAPY(b.id) - getBestNetAPY(a.id),
      ))
      break
    case 'Total Supply':
      sorted = applyFeaturedSort([...filteredMarkets.value].sort((a, b) =>
        b.metrics.totalTVL - a.metrics.totalTVL,
      ))
      break
    case 'Total Borrowed':
      sorted = applyFeaturedSort([...filteredMarkets.value].sort((a, b) =>
        b.metrics.totalBorrowed - a.metrics.totalBorrowed,
      ))
      break
    case 'Available Liquidity':
      sorted = applyFeaturedSort([...filteredMarkets.value].sort((a, b) =>
        b.metrics.totalAvailableLiquidity - a.metrics.totalAvailableLiquidity,
      ))
      break
    default:
      sorted = applyFeaturedSort([...filteredMarkets.value])
  }
  const directed = sortDir.value === 'asc' ? [...sorted].reverse() : sorted
  return applyDeprecatedGroupSort(directed)
})

const isLoading = computed(() =>
  isUpdating.value || isEarnUpdating.value || isEscrowUpdating.value
  || isResolvingTVL.value || marketGroups.value.length === 0,
)
</script>

<template>
  <section class="flex flex-col min-h-[calc(100dvh-178px)]">
    <PageHeader
      title="Explore"
      icon="nodes"
    >
      <template #search>
        <UiInput
          v-model="searchQuery"
          placeholder="Search by asset, market, curator..."
          icon="search"
          clearable
          class="w-[280px] shrink-0"
        />
      </template>
      <template #filters>
        <VaultSortButton
          v-model="sortBy"
          v-model:dir="sortDir"
          :options="['Recommended', 'Best Net APY', 'Total Supply', 'Total Borrowed', 'Available Liquidity']"
          :disable-dir="sortBy === 'Recommended'"
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
      </template>
    </PageHeader>

    <div class="flex flex-col flex-1">
      <UiLoader
        v-if="isLoading"
        class="flex-1 self-center justify-self-center"
      />

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
