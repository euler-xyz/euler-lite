<script setup lang="ts">
import type { EulerEarn } from '@eulerxyz/euler-v2-sdk'
import { useVaults } from '~/composables/useVaults'
import { useVaultRegistry } from '~/composables/useVaultRegistry'
import { useEulerAddresses } from '~/composables/useEulerAddresses'
import { getAssetLogoUrl } from '~/composables/useTokenList'

import { getAssetUsdValueOrZero } from '~/utils/sdk-prices'
import { getProductByVault, applyVaultOverrides, getEntitiesByEarnVault, isVaultRecentlyAdded, isVaultDeprecated, isEarnVaultNotExplorable } from '~/utils/eulerLabelsUtils'
import { getEulerLabelEntityLogo } from '~/entities/euler/labels'
import { useCustomFilters } from '~/composables/useCustomFilters'
import { useVaultSearch } from '~/composables/useVaultSearch'
import { buildTvlSortedOptions } from '~/utils/buildTvlSortedOptions'
import { DEBOUNCE_LIST_PRICE_FETCH_MS } from '~/entities/tuning-constants'
import { compareRecentlyAddedBoost } from '~/utils/recentlyAddedSort'

defineOptions({
  name: 'EarnPage',
})

const { isEarnUpdating } = useVaults()
const isPricesReady = ref(false)
const { isReady: labelsReady } = useEulerLabels()
const isLoading = computed(() => isEarnUpdating.value || !labelsReady.value || !isPricesReady.value)
const { isSlow } = useSlowLoading(isLoading)
const { getEarnVaults, isVerifiedVault } = useVaultRegistry()
const { chainId } = useEulerAddresses()
const showAllLabelEntries = useShowAllLabelEntries()
const list = computed(() => getEarnVaults().filter(v =>
  isVerifiedVault(v.address) && (showAllLabelEntries.value || !isEarnVaultNotExplorable(v.address)),
))

const { enableEntityBranding } = useDeployConfig()

const { searchQuery, matchesSearch, clearSearch } = useVaultSearch<EulerEarn>((vault) => {
  const product = applyVaultOverrides(getProductByVault(vault.address), vault.address)
  return [
    vault.asset.symbol,
    vault.asset.name,
    vault.shares.name,
    product.name,
    product.description,
    ...getEntitiesByEarnVault(vault).map(e => e.name),
  ]
})

const selectedCollateral = ref<string[]>([])
const selectedCurators = ref<string[]>([])
const sortBy = ref<string>('Total Supply')
const sortDir = ref<'desc' | 'asc'>('desc')

useUrlQuerySync([
  { ref: searchQuery, default: '', queryKey: 'search' },
  { ref: sortBy, default: 'Total Supply', queryKey: 'sort' },
  { ref: sortDir, default: 'desc', queryKey: 'dir' },
  { ref: selectedCollateral, default: [], queryKey: 'vault' },
  { ref: selectedCurators, default: [], queryKey: 'allocator' },
])

// Cache for USD values used in sorting (keyed by vault address)
const vaultTotalSupplyUsd = ref<Map<string, number>>(new Map())
const vaultLiquidityUsd = ref<Map<string, number>>(new Map())

// Fetch USD values for all earn vaults. Debounced to collapse the bursts
// of registry updates streamed during loadVaults's RPC refresh.
const fetchEarnPrices = useDebounceFn(async () => {
  const vaults = list.value
  if (!vaults.length) {
    isPricesReady.value = true
    return
  }

  try {
    const totalSupplyValues = new Map<string, number>()
    const liquidityValues = new Map<string, number>()
    await Promise.all(
      vaults.map(async (vault) => {
        const [totalSupply, liquidity] = await Promise.all([
          getAssetUsdValueOrZero(vault.totalAssets, vault, 'off-chain'),
          getAssetUsdValueOrZero(vault.availableAssets, vault, 'off-chain'),
        ])
        totalSupplyValues.set(vault.address, totalSupply)
        liquidityValues.set(vault.address, liquidity)
      }),
    )
    vaultTotalSupplyUsd.value = totalSupplyValues
    vaultLiquidityUsd.value = liquidityValues
  }
  finally {
    isPricesReady.value = true
  }
}, DEBOUNCE_LIST_PRICE_FETCH_MS)

// Pause price fetches while the page is in keep-alive but not visible. See the
// borrow-page equivalent for the full rationale.
const isActive = ref(true)
onActivated(() => {
  isActive.value = true
})
onDeactivated(() => {
  isActive.value = false
})

watchEffect(() => {
  void list.value
  if (!isActive.value) return
  fetchEarnPrices()
})

const {
  customFilters,
  removeCustomFilter,
  clearCustomFilters,
  openCustomFilterModal,
  matchesCustomFilters,
} = useCustomFilters<EulerEarn>(
  [
    { key: 'totalSupply', label: 'Total supply', shortLabel: 'Total supply', unit: 'usd' },
    { key: 'liquidity', label: 'Available liquidity', shortLabel: 'Avail. liquidity', unit: 'usd' },
  ],
  (vault, metric) => {
    if (metric === 'totalSupply') return vaultTotalSupplyUsd.value.get(vault.address) ?? 0
    if (metric === 'liquidity') return vaultLiquidityUsd.value.get(vault.address) ?? 0
    return 0
  },
)

watch(chainId, (newChainId, oldChainId) => {
  if (oldChainId !== undefined && newChainId !== oldChainId) {
    clearSearch()
    selectedCollateral.value = []
    selectedCurators.value = []
    clearCustomFilters()
  }
})

const assetOptions = computed(() => {
  return list.value
    .map(vault => ({
      label: vault.asset.symbol,
      value: vault.asset.address,
      icon: getAssetLogoUrl(vault.asset.address, vault.asset.symbol),
    }))
    .reduce((prev, curr) =>
      prev.find(vault => vault.value === curr.value) ? prev : [...prev, curr], [] as { label: string, value: string, icon: string }[],
    )
})

const curatorOptions = computed(() => {
  return buildTvlSortedOptions(list.value.flatMap((vault) => {
    const tvl = vaultTotalSupplyUsd.value.get(vault.address) ?? 0
    return getEntitiesByEarnVault(vault).map(entity => ({
      key: entity.name, label: entity.name, tvl, icon: entity.logo ? `/entities/${entity.logo}` : undefined, iconFallback: entity.logo ? getEulerLabelEntityLogo(entity.logo) : undefined,
    }))
  }))
})

const filteredList = computed(() => {
  return list.value
    .filter(matchesSearch)
    .filter(vault => selectedCollateral.value.length ? selectedCollateral.value.includes(vault.asset.address) : true)
    .filter(vault => selectedCurators.value.length ? getEntitiesByEarnVault(vault).some(e => selectedCurators.value.includes(e.name)) : true)
    .filter(matchesCustomFilters)
})

const applyRecentlyAddedSort = <T extends { address: string }>(sorted: T[]): T[] => {
  return [...sorted].sort((a, b) => {
    return compareRecentlyAddedBoost(
      isVaultRecentlyAdded(a.address),
      vaultLiquidityUsd.value.get(a.address) ?? 0,
      isVaultRecentlyAdded(b.address),
      vaultLiquidityUsd.value.get(b.address) ?? 0,
    )
  })
}

const applyDeprecatedSort = <T extends { address: string }>(sorted: T[]): T[] => {
  return [...sorted].sort((a, b) => {
    const ad = isVaultDeprecated(a.address) ? 1 : 0
    const bd = isVaultDeprecated(b.address) ? 1 : 0
    return ad - bd
  })
}

const sortedList = computed(() => {
  let sorted: EulerEarn[]
  switch (sortBy.value) {
    case 'Total Supply':
      sorted = applyRecentlyAddedSort([...filteredList.value].sort((a: EulerEarn, b: EulerEarn) => {
        const aValue = vaultTotalSupplyUsd.value.get(a.address) ?? 0
        const bValue = vaultTotalSupplyUsd.value.get(b.address) ?? 0
        return bValue - aValue
      }))
      break
    case 'Supply APY':
      sorted = applyRecentlyAddedSort([...filteredList.value].sort((a: EulerEarn, b: EulerEarn) => {
        return Number(getVaultSupplyApy(b)) - Number(getVaultSupplyApy(a))
      }))
      break
    case 'Liquidity':
      sorted = applyRecentlyAddedSort([...filteredList.value].sort((a: EulerEarn, b: EulerEarn) => {
        const aValue = vaultLiquidityUsd.value.get(a.address) ?? 0
        const bValue = vaultLiquidityUsd.value.get(b.address) ?? 0
        return bValue - aValue
      }))
      break
    default:
      sorted = applyRecentlyAddedSort([...filteredList.value])
  }
  const directed = sortDir.value === 'asc' ? [...sorted].reverse() : sorted
  return applyDeprecatedSort(directed)
})
</script>

<template>
  <section class="flex flex-col min-h-[calc(100dvh-178px)]">
    <BasePageHeader
      title="Earn"
      description="One deposit, diversified yield. Curators allocate your capital across multiple lending strategies."
      class="mb-16"
      arrow-right
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
            { label: 'Total Supply', icon: 'lend-outline' },
            { label: 'Liquidity', icon: 'wallet' },
            { label: 'Supply APY', icon: 'percent' },
          ]"
          title="Sorting type"
        />
        <UiSelect
          v-if="enableEntityBranding"
          :key="`curators-${chainId}`"
          v-model="selectedCurators"
          :options="curatorOptions"
          placeholder="Capital allocator"
          title="Capital allocator"
          modal-input-placeholder="Search allocator"
          icon="search-user"
        />
        <UiSelect
          :key="`collateral-${chainId}`"
          v-model="selectedCollateral"
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

      <VaultsEarnList
        v-else-if="sortedList.length"
        type="lend"
        :items="sortedList"
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
