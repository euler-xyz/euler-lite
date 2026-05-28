<script setup lang="ts">
import type { EVault } from '@eulerxyz/euler-v2-sdk'
import { useVaults } from '~/composables/useVaults'
import { useVaultRegistry } from '~/composables/useVaultRegistry'
import { useEulerAddresses } from '~/composables/useEulerAddresses'
import { getAssetLogoUrl } from '~/composables/useTokenList'

import { getAssetUsdValueOrZero } from '~/utils/sdk-prices'
import { getProductByVault, applyVaultOverrides, getEntitiesByVault, isVaultRecentlyAdded, isVaultDeprecated, isVaultNotExplorableLend } from '~/utils/eulerLabelsUtils'
import { getEulerLabelEntityLogo } from '~/entities/euler/labels'
import { useCustomFilters } from '~/composables/useCustomFilters'
import { useVaultSearch } from '~/composables/useVaultSearch'
import { isOpDisabled, OP_DEPOSIT } from '~/utils/vault-hooks'
import { buildTvlSortedOptions } from '~/utils/buildTvlSortedOptions'
import { DEBOUNCE_LIST_PRICE_FETCH_MS } from '~/entities/tuning-constants'
import { withVaultIntrinsicApy } from '~/utils/vault-intrinsic-apy'

defineOptions({
  name: 'LendPage',
})

const { borrowList, isEVaultUpdating } = useVaults()
const { getVerifiedEVaults } = useVaultRegistry()
const { chainId } = useEulerAddresses()
const showAllLabelEntries = useShowAllLabelEntries()
const list = computed(() => getVerifiedEVaults(showAllLabelEntries.value))

const isPricesReady = ref(false)
const isLoading = computed(() => isEVaultUpdating.value || !isPricesReady.value)
const { isSlow } = useSlowLoading(isLoading)
const { entities } = useEulerLabels()
const { settings } = useUserSettings()
const enableIntrinsicApy = computed(() => settings.value.enableIntrinsicApy)
const { getSupplyRewardApy, version: rewardsVersion } = useRewardsApy()
const { getBalance } = useWallets()

const { enableEntityBranding } = useDeployConfig()

const { searchQuery, matchesSearch, clearSearch } = useVaultSearch<EVault>((vault) => {
  const product = applyVaultOverrides(getProductByVault(vault.address), vault.address)
  return [
    vault.asset.symbol,
    vault.asset.name,
    vault.shares.name,
    product.name,
    product.description,
    ...getEntitiesByVault(vault).map(e => e.name),
  ]
})

const selectedCollateral = ref<string[]>([])
const selectedMarkets = ref<string[]>([])
const selectedRiskManagers = ref<string[]>([])
const sortBy = ref<string>('Total Supply')
const sortDir = ref<'desc' | 'asc'>('desc')

useUrlQuerySync([
  { ref: searchQuery, default: '', queryKey: 'search' },
  { ref: sortBy, default: 'Total Supply', queryKey: 'sort' },
  { ref: sortDir, default: 'desc', queryKey: 'dir' },
  { ref: selectedCollateral, default: [], queryKey: 'vault' },
  { ref: selectedMarkets, default: [], queryKey: 'market' },
  { ref: selectedRiskManagers, default: [], queryKey: 'riskManager' },
])

// Cache for USD values used in sorting and filtering (keyed by vault address)
const vaultUsdValues = ref<Map<string, number>>(new Map())
const vaultLiquidityUsd = ref<Map<string, number>>(new Map())
const vaultWalletUsd = ref<Map<string, number>>(new Map())

const getDisplayedVaultSupplyApy = (vault: EVault): number => {
  const baseApy = getVaultSupplyApy(vault)
  return withVaultIntrinsicApy(baseApy, vault, enableIntrinsicApy.value) + getSupplyRewardApy(vault.address)
}

const {
  customFilters,
  removeCustomFilter,
  clearCustomFilters,
  openCustomFilterModal,
  matchesCustomFilters,
} = useCustomFilters<EVault>(
  [
    { key: 'totalSupply', label: 'Total supply', shortLabel: 'Total supply', unit: 'usd' },
    { key: 'liquidity', label: 'Available liquidity', shortLabel: 'Avail. liquidity', unit: 'usd' },
    { key: 'inWallet', label: 'In wallet', shortLabel: 'In wallet', unit: 'usd' },
    { key: 'supplyApy', label: 'Supply APY', shortLabel: 'Supply APY', unit: 'percent' },
    { key: 'utilization', label: 'Utilization', shortLabel: 'Utilization', unit: 'percent' },
  ],
  (vault, metric) => {
    switch (metric) {
      case 'totalSupply': return vaultUsdValues.value.get(vault.address) ?? 0
      case 'liquidity': return vaultLiquidityUsd.value.get(vault.address) ?? 0
      case 'inWallet': return vaultWalletUsd.value.get(vault.address) ?? 0
      case 'supplyApy': return getDisplayedVaultSupplyApy(vault)
      case 'utilization': return vault.utilization
      default: return 0
    }
  },
)

watch(chainId, (newChainId, oldChainId) => {
  if (oldChainId !== undefined && newChainId !== oldChainId) {
    clearSearch()
    selectedCollateral.value = []
    selectedMarkets.value = []
    selectedRiskManagers.value = []
    clearCustomFilters()
  }
})

// Lend listing only checks OP_DEPOSIT: it shows a vault as long as depositing is possible,
// regardless of OP_TRANSFER state. Contrast with borrow/index.vue which checks both.
const borrowableVaults = computed(() => {
  return list.value.filter(vault =>
    (showAllLabelEntries.value || !isVaultNotExplorableLend(vault.address))
    && borrowList.value.some(pair => pair.borrow.address === vault.address)
    && !isOpDisabled(vault, OP_DEPOSIT),
  )
})

// Fetch USD values for all borrowable vaults. Debounced to collapse the
// bursts of registry updates streamed during loadVaults's RPC refresh
// (each batch causes borrowableVaults to re-derive) into a single
// price-fetch cycle. Reading rewardsVersion.value establishes a reactive
// dependency so this also re-runs when reward data loads asynchronously.
const fetchLendPrices = useDebounceFn(async () => {
  const vaults = borrowableVaults.value
  if (!vaults.length) {
    isPricesReady.value = true
    return
  }

  try {
    const supplyValues = new Map<string, number>()
    const liquidityValues = new Map<string, number>()
    const walletValues = new Map<string, number>()

    await Promise.all(
      vaults.map(async (vault) => {
        const walletBalance = getBalance(vault.asset.address as `0x${string}`)
        const liquidity = vault.availableLiquidity
        const [totalSupply, liquidityUsd, wallet] = await Promise.all([
          getAssetUsdValueOrZero(vault.totalAssets, vault, 'off-chain'),
          getAssetUsdValueOrZero(liquidity, vault, 'off-chain'),
          walletBalance > 0n ? getAssetUsdValueOrZero(walletBalance, vault, 'off-chain') : Promise.resolve(0),
        ])
        supplyValues.set(vault.address, totalSupply)
        liquidityValues.set(vault.address, liquidityUsd)
        walletValues.set(vault.address, wallet)
      }),
    )

    vaultUsdValues.value = supplyValues
    vaultLiquidityUsd.value = liquidityValues
    vaultWalletUsd.value = walletValues
  }
  finally {
    isPricesReady.value = true
  }
}, DEBOUNCE_LIST_PRICE_FETCH_MS)

// Pause price fetches while the page is in keep-alive but not visible.
// See the borrow-page equivalent for the full rationale — avoiding a
// bulk refetch while a hidden page's data changes.
const isActive = ref(true)
onActivated(() => {
  isActive.value = true
})
onDeactivated(() => {
  isActive.value = false
})

watchEffect(() => {
  // Touch deps so watchEffect re-registers on change, then delegate to the
  // debounced fetcher. Values are re-read inside fetchLendPrices at execution
  // time to avoid closing over stale references.
  void rewardsVersion.value
  void borrowableVaults.value
  if (!isActive.value) return
  fetchLendPrices()
})

const marketOptions = computed(() => {
  return buildTvlSortedOptions(borrowableVaults.value.flatMap((vault) => {
    const market = getProductByVault(vault.address)
    if (!market.name) return []
    const entityName = Array.isArray(market?.entity) ? market?.entity[0] : market?.entity
    const entityObj = entityName ? entities[entityName] : null
    return [{ key: market.name, label: market.name, tvl: vaultUsdValues.value.get(vault.address) ?? 0, icon: entityObj?.logo ? `/entities/${entityObj.logo}` : undefined, iconFallback: entityObj?.logo ? getEulerLabelEntityLogo(entityObj.logo) : undefined }]
  }))
})

const assetOptions = computed(() => {
  return borrowableVaults.value
    .map(vault => ({
      label: vault.asset.symbol,
      value: vault.asset.address,
      icon: getAssetLogoUrl(vault.asset.address, vault.asset.symbol),
    }))
    .reduce((prev, curr) =>
      prev.find(vault => vault.value === curr.value) ? prev : [...prev, curr], [] as { label: string, value: string, icon: string }[],
    )
})

const riskManagerOptions = computed(() => {
  return buildTvlSortedOptions(borrowableVaults.value.flatMap((vault) => {
    const tvl = vaultUsdValues.value.get(vault.address) ?? 0
    return getEntitiesByVault(vault).map(entity => ({
      key: entity.name, label: entity.name, tvl, icon: entity.logo ? `/entities/${entity.logo}` : undefined, iconFallback: entity.logo ? getEulerLabelEntityLogo(entity.logo) : undefined,
    }))
  }))
})

const filteredList = computed(() => {
  return borrowableVaults.value
    .filter(matchesSearch)
    .filter(vault => selectedCollateral.value.length ? selectedCollateral.value.includes(vault.asset.address) : true)
    .filter(vault => selectedMarkets.value.length ? selectedMarkets.value.includes(getProductByVault(vault.address).name) : true)
    .filter(vault => selectedRiskManagers.value.length
      ? getEntitiesByVault(vault).some(e => selectedRiskManagers.value.includes(e.name))
      : true)
    .filter(matchesCustomFilters)
})

const applyRecentlyAddedSort = <T extends { address: string }>(sorted: T[]): T[] => {
  return [...sorted].sort((a, b) => {
    const af = isVaultRecentlyAdded(a.address) ? 1 : 0
    const bf = isVaultRecentlyAdded(b.address) ? 1 : 0
    return bf - af
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
  let sorted: EVault[]
  switch (sortBy.value) {
    case 'Total Supply':
      sorted = applyRecentlyAddedSort([...filteredList.value].sort((a: EVault, b: EVault) => {
        const aValue = vaultUsdValues.value.get(a.address) ?? 0
        const bValue = vaultUsdValues.value.get(b.address) ?? 0
        return bValue - aValue
      }))
      break
    case 'Supply APY':
      sorted = applyRecentlyAddedSort([...filteredList.value].sort((a: EVault, b: EVault) => {
        return Number(getDisplayedVaultSupplyApy(b)) - Number(getDisplayedVaultSupplyApy(a))
      }))
      break
    case 'Utilization':
      sorted = applyRecentlyAddedSort([...filteredList.value].sort((a: EVault, b: EVault) => {
        return b.utilization - a.utilization
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
      title="Lend"
      description="Supply assets to isolated lending markets. Earn yield from borrower demand."
      class="mb-16"
      arrow-down
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
            { label: 'Utilization', icon: 'pulse' },
            { label: 'Supply APY', icon: 'percent' },
          ]"
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

      <VaultsList
        v-else-if="sortedList.length"
        type="lend"
        :items="sortedList"
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
