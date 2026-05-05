<script setup lang="ts">
import { maxUint256 } from 'viem'
import type { MarketGroup } from '~/entities/lend-discovery'
import type { EVault, SecuritizeCollateralVault, AnyBorrowVaultPair } from '~/entities/vault'
import { formatCompactUsdValue } from '~/utils/string-utils'
import { formatAssetValue } from '~/services/pricing/priceProvider'
import {
  isVaultType,
  getVaultAddress,
  getMiniDiagram,
  getCollateralMatrix,
  findVault,
  getAttributeMatrix,
  isMatrixCompatibleVault,
  formatCapDisplay,
  isAttributeMatrixView,
  buildVaultApyCache,
  MATRIX_VIEW_OPTIONS,
  type CollateralMatrixData,
  type DotMetric,
  type ExpandedViewMode,
  type MatrixVariant,
  type AttributeMatrixData,
  type MatrixViewId,
  type VaultUsdCacheEntry,
  type VaultApyCacheEntry,
} from '~/utils/discoveryCalculations'

const props = defineProps<{
  markets: MarketGroup[]
  initialExpanded?: string[]
}>()

const route = useRoute()
const { chainId } = useEulerAddresses()
const shareLinkQuery = computed(() => {
  const network = route.query.network

  return {
    network: Array.isArray(network) ? network[0] ?? chainId.value : network ?? chainId.value,
  }
})

// -- Accordion expand state --

const expandedMarkets = ref<Set<string>>(new Set(props.initialExpanded ?? []))

const toggleExpand = (marketId: string) => {
  const next = new Set(expandedMarkets.value)
  if (next.has(marketId)) {
    next.delete(marketId)
    if (selectedCell.value?.marketId === marketId) {
      selectedCell.value = null
    }
    if (selectedMatrixHeader.value?.marketId === marketId) {
      selectedMatrixHeader.value = null
    }
    if (selectedGraphNode.value?.marketId === marketId) {
      selectedGraphNode.value = null
    }
    if (matrixDropdownOpenMarketId.value === marketId) {
      matrixDropdownOpenMarketId.value = null
    }
  }
  else {
    next.add(marketId)
  }
  expandedMarkets.value = next
}

const isExpanded = (marketId: string) => expandedMarkets.value.has(marketId)

// -- Expanded view mode (graph vs matrix) --

const expandedViewModes = ref<Map<string, ExpandedViewMode>>(new Map())

const getExpandedView = (marketId: string): ExpandedViewMode =>
  expandedViewModes.value.get(marketId) ?? 'graph'

const setExpandedView = (marketId: string, mode: ExpandedViewMode) => {
  const next = new Map(expandedViewModes.value)
  next.set(marketId, mode)
  expandedViewModes.value = next
  if (mode === 'graph') {
    if (selectedCell.value?.marketId === marketId) {
      selectedCell.value = null
    }
    if (selectedMatrixHeader.value?.marketId === marketId) {
      selectedMatrixHeader.value = null
    }
    if (matrixDropdownOpenMarketId.value === marketId) {
      matrixDropdownOpenMarketId.value = null
    }
  }
  else {
    if (selectedGraphNode.value?.marketId === marketId) {
      selectedGraphNode.value = null
    }
  }
}

// -- Per-vault USD values (loaded on expand) --

const vaultUsdCache = ref<Map<string, VaultUsdCacheEntry>>(new Map())

const formatUsdOrDisplay = (p: { hasPrice: boolean, usdValue: number, display: string }) =>
  p.hasPrice ? formatCompactUsdValue(p.usdValue) : p.display

const loadVaultUsdValues = async (market: MarketGroup) => {
  const newEntries = new Map(vaultUsdCache.value)
  const allVaults = [...market.vaults, ...market.externalCollateral].filter(isMatrixCompatibleVault)

  await Promise.all(
    allVaults.map(async (vault) => {
      const addr = getVaultAddress(vault).toLowerCase()
      if (!addr || newEntries.has(addr)) return
      const totalAssets = 'totalAssets' in vault ? vault.totalAssets as bigint : 0n
      const borrow = 'totalBorrowed' in vault ? vault.totalBorrowed as bigint : 0n
      const supplyCapRaw = 'caps' in vault ? vault.caps.supplyCap : ('supplyCap' in vault ? vault.supplyCap as bigint : maxUint256)
      const borrowCapRaw = 'caps' in vault ? vault.caps.borrowCap : maxUint256

      const liquidity = 'availableLiquidity' in vault ? vault.availableLiquidity : 0n
      const supplyCapHasPrice = supplyCapRaw > 0n && supplyCapRaw < maxUint256
      const borrowCapHasPrice = borrowCapRaw > 0n && borrowCapRaw < maxUint256

      const [supplyPrice, borrowPrice, liquidityPrice, supplyCapPrice, borrowCapPrice] = await Promise.all([
        formatAssetValue(totalAssets, vault, 'off-chain'),
        formatAssetValue(borrow, vault, 'off-chain'),
        formatAssetValue(liquidity, vault, 'off-chain'),
        supplyCapHasPrice ? formatAssetValue(supplyCapRaw, vault, 'off-chain') : null,
        borrowCapHasPrice ? formatAssetValue(borrowCapRaw, vault, 'off-chain') : null,
      ])

      newEntries.set(addr, {
        supply: formatUsdOrDisplay(supplyPrice),
        supplyUsd: supplyPrice.hasPrice ? supplyPrice.usdValue : 0,
        borrow: formatUsdOrDisplay(borrowPrice),
        borrowUsd: borrowPrice.hasPrice ? borrowPrice.usdValue : 0,
        liquidity: formatUsdOrDisplay(liquidityPrice),
        liquidityUsd: liquidityPrice.hasPrice ? liquidityPrice.usdValue : 0,
        supplyCap: formatCapDisplay(supplyCapRaw, supplyCapPrice ? formatUsdOrDisplay(supplyCapPrice) : null).display,
        supplyCapUsd: supplyCapPrice?.hasPrice ? supplyCapPrice.usdValue : undefined,
        borrowCap: formatCapDisplay(borrowCapRaw, borrowCapPrice ? formatUsdOrDisplay(borrowCapPrice) : null).display,
        borrowCapUsd: borrowCapPrice?.hasPrice ? borrowCapPrice.usdValue : undefined,
      })
    }),
  )

  vaultUsdCache.value = newEntries
}

const onToggle = (market: MarketGroup) => {
  const wasExpanded = isExpanded(market.id)
  toggleExpand(market.id)
  if (!wasExpanded) loadVaultUsdValues(market)
}

// -- Matrix view selector (single dropdown spans Stats, Configuration,
// Oracles, and the four numeric pair metrics) --

const matrixViews = ref<Map<string, MatrixViewId>>(new Map())
const matrixDropdownOpenMarketId = ref<string | null>(null)

const getMatrixView = (marketId: string): MatrixViewId =>
  matrixViews.value.get(marketId) ?? 'stats'

const getMatrixVariant = (marketId: string): MatrixVariant => {
  const view = getMatrixView(marketId)
  return isAttributeMatrixView(view) ? view : 'pairs'
}

const getDotMetric = (marketId: string): DotMetric => {
  const view = getMatrixView(marketId)
  if (isAttributeMatrixView(view)) return 'net-apy' // unused for attribute matrices
  return view
}

const setMatrixView = (marketId: string, view: MatrixViewId) => {
  if (getMatrixView(marketId) === view) {
    matrixDropdownOpenMarketId.value = null
    return
  }
  const next = new Map(matrixViews.value)
  next.set(marketId, view)
  matrixViews.value = next
  matrixDropdownOpenMarketId.value = null
  if (selectedCell.value?.marketId === marketId) {
    selectedCell.value = null
  }
  if (selectedMatrixHeader.value?.marketId === marketId) {
    selectedMatrixHeader.value = null
  }
}

const isMatrixDropdownOpen = (marketId: string) => matrixDropdownOpenMarketId.value === marketId

const toggleMatrixDropdown = (marketId: string) => {
  matrixDropdownOpenMarketId.value = isMatrixDropdownOpen(marketId) ? null : marketId
}

// -- Precomputed matrix map --

const matrixMap = computed((): Map<string, CollateralMatrixData | null> => {
  const result = new Map<string, CollateralMatrixData | null>()
  for (const market of props.markets) {
    result.set(market.id, getCollateralMatrix(market))
  }
  return result
})

const attributeMatrixMap = computed((): Map<string, AttributeMatrixData> => {
  const result = new Map<string, AttributeMatrixData>()
  for (const market of props.markets) {
    const matrixView = getMatrixView(market.id)
    if (isAttributeMatrixView(matrixView)) {
      result.set(market.id, getAttributeMatrix(market, matrixView))
    }
  }
  return result
})

// Stats matrix needs the same APY users see on per-vault cards (base IRM rate
// folded with intrinsic + supply/borrow rewards). The composables fetch this
// data asynchronously and bump `version` when it lands; the explicit reads
// here re-trigger the computed so the cells refresh in place.
const { withIntrinsicSupplyApy, withIntrinsicBorrowApy, version: intrinsicVersion } = useIntrinsicApy()
const { getSupplyRewardApy, getBorrowRewardApy, version: rewardsVersion } = useRewardsApy()

const vaultApyCache = computed<Map<string, VaultApyCacheEntry>>(() => {
  void intrinsicVersion.value
  void rewardsVersion.value
  return buildVaultApyCache(
    props.markets,
    withIntrinsicSupplyApy,
    withIntrinsicBorrowApy,
    getSupplyRewardApy,
    getBorrowRewardApy,
  )
})

// -- Cell selection state (matrix view) --

const selectedCell = ref<{
  marketId: string
  collateralAddr: string
  liabilityAddr: string
} | null>(null)

// -- Matrix header selection state --

const selectedMatrixHeader = ref<{
  marketId: string
  address: string
  axis: 'row' | 'column'
} | null>(null)

const toggleMatrixHeader = (marketId: string, address: string, axis: 'row' | 'column') => {
  if (
    selectedMatrixHeader.value?.marketId === marketId
    && selectedMatrixHeader.value?.address === address
    && selectedMatrixHeader.value?.axis === axis
  ) {
    selectedMatrixHeader.value = null
    return
  }
  selectedMatrixHeader.value = { marketId, address, axis }
  selectedCell.value = null
}

// -- Graph node selection state --

const selectedGraphNode = ref<{
  marketId: string
  address: string
} | null>(null)

const toggleGraphNode = (marketId: string, address: string) => {
  if (selectedGraphNode.value?.marketId === marketId && selectedGraphNode.value?.address === address) {
    selectedGraphNode.value = null
  }
  else {
    selectedGraphNode.value = { marketId, address }
  }
}

// -- Cell click (matrix view) --

const onCellClick = (marketId: string, collateralAddr: string, liabilityAddr: string) => {
  if (
    selectedCell.value?.marketId === marketId
    && selectedCell.value?.collateralAddr === collateralAddr
    && selectedCell.value?.liabilityAddr === liabilityAddr
  ) {
    selectedCell.value = null
    return
  }
  selectedCell.value = { marketId, collateralAddr, liabilityAddr }
  selectedMatrixHeader.value = null
}

// -- Selection → vault resolution --

const getSelectedLendVault = (market: MarketGroup): EVault | SecuritizeCollateralVault | null => {
  if (!selectedCell.value || selectedCell.value.marketId !== market.id) return null
  return findVault(market, selectedCell.value.liabilityAddr)
}

const getSelectedBorrowPair = (market: MarketGroup): AnyBorrowVaultPair | null => {
  if (!selectedCell.value || selectedCell.value.marketId !== market.id) return null
  const matrix = matrixMap.value.get(market.id)
  if (!matrix) return null
  const cell = matrix.cells.get(selectedCell.value.collateralAddr)?.get(selectedCell.value.liabilityAddr)
  if (!cell) return null
  const collateral = findVault(market, selectedCell.value.collateralAddr)
  const borrow = findVault(market, selectedCell.value.liabilityAddr)
  if (!collateral || !borrow || !isVaultType(borrow)) return null
  return {
    borrow,
    collateral,
    ltv: cell.ltv,
  } as AnyBorrowVaultPair
}

const getMatrixHeaderVault = (market: MarketGroup): EVault | SecuritizeCollateralVault | null => {
  if (!selectedMatrixHeader.value || selectedMatrixHeader.value.marketId !== market.id) return null
  return findVault(market, selectedMatrixHeader.value.address)
}

const getMatrixHeaderBorrowPairs = (market: MarketGroup): AnyBorrowVaultPair[] => {
  if (!selectedMatrixHeader.value || selectedMatrixHeader.value.marketId !== market.id) return []
  const matrix = matrixMap.value.get(market.id)
  if (!matrix) return []

  const addr = selectedMatrixHeader.value.address.toLowerCase()
  const pairs: AnyBorrowVaultPair[] = []

  if (selectedMatrixHeader.value.axis === 'column') {
    for (const [collateralAddr, rowCells] of matrix.cells) {
      const cell = rowCells.get(addr)
      if (!cell || cell.ltv.borrowLTV <= 0) continue
      const collateral = findVault(market, collateralAddr)
      const borrow = findVault(market, addr)
      if (!collateral || !borrow || !isVaultType(borrow)) continue
      pairs.push({
        borrow,
        collateral,
        ltv: cell.ltv,
      } as AnyBorrowVaultPair)
    }
  }
  else {
    const rowCells = matrix.cells.get(addr)
    if (!rowCells) return []
    for (const [liabilityAddr, cell] of rowCells) {
      if (cell.ltv.borrowLTV <= 0) continue
      const collateral = findVault(market, addr)
      const borrow = findVault(market, liabilityAddr)
      if (!collateral || !borrow || !isVaultType(borrow)) continue
      pairs.push({
        borrow,
        collateral,
        ltv: cell.ltv,
      } as AnyBorrowVaultPair)
    }
  }

  return pairs
}

const getGraphSelectedVault = (market: MarketGroup): EVault | SecuritizeCollateralVault | null => {
  if (!selectedGraphNode.value || selectedGraphNode.value.marketId !== market.id) return null
  return findVault(market, selectedGraphNode.value.address)
}

const getGraphBorrowPairs = (market: MarketGroup): AnyBorrowVaultPair[] => {
  if (!selectedGraphNode.value || selectedGraphNode.value.marketId !== market.id) return []
  const matrix = matrixMap.value.get(market.id)
  if (!matrix) return []

  const selectedAddr = selectedGraphNode.value.address.toLowerCase()
  const pairs: AnyBorrowVaultPair[] = []

  for (const [collateralAddr, rowCells] of matrix.cells) {
    const cell = rowCells.get(selectedAddr)
    if (!cell || cell.ltv.borrowLTV <= 0) continue
    const collateral = findVault(market, collateralAddr)
    const borrow = findVault(market, selectedAddr)
    if (!collateral || !borrow || !isVaultType(borrow)) continue
    pairs.push({
      borrow,
      collateral,
      ltv: cell.ltv,
    } as AnyBorrowVaultPair)
  }

  return pairs
}

// -- Has any selection for a market --

const hasSelection = (market: MarketGroup): boolean => {
  const view = getExpandedView(market.id)
  if (view === 'matrix') {
    return (!!selectedCell.value && selectedCell.value.marketId === market.id)
      || (!!selectedMatrixHeader.value && selectedMatrixHeader.value.marketId === market.id)
  }
  return !!selectedGraphNode.value && selectedGraphNode.value.marketId === market.id
}

// -- Global event handlers --

onMounted(() => {
  const onClick = () => {
    matrixDropdownOpenMarketId.value = null
  }
  window.addEventListener('click', onClick)
  onUnmounted(() => {
    window.removeEventListener('click', onClick)
  })

  for (const market of props.markets) {
    if (expandedMarkets.value.has(market.id)) {
      loadVaultUsdValues(market)
    }
  }
})
</script>

<template>
  <div class="flex flex-col gap-8">
    <article
      v-for="market in markets"
      :key="market.id"
      class="bg-surface rounded-12 border border-line-default shadow-card transition-all"
      :class="isExpanded(market.id) ? 'shadow-card-hover border-line-emphasis' : 'hover:shadow-card-hover hover:border-line-emphasis'"
    >
      <!-- Collapsed Row Card -->
      <DiscoveryMarketCard
        :market="market"
        :is-expanded="isExpanded(market.id)"
        @toggle="onToggle(market)"
      />

      <!-- Expanded Content -->
      <template v-if="isExpanded(market.id)">
        <!-- Fallback for markets with no active collateral relationships -->
        <template v-if="!matrixMap.get(market.id)">
          <div class="border-t border-line-subtle p-16 flex flex-col gap-12">
            <div class="flex flex-col gap-8">
              <h4 class="text-p3 font-medium text-content-secondary">
                Vaults
              </h4>
              <template
                v-for="vault in market.vaults"
                :key="getVaultAddress(vault)"
              >
                <VaultItem
                  v-if="isVaultType(vault)"
                  :vault="vault"
                />
                <SecuritizeVaultItem
                  v-else
                  :vault="vault as SecuritizeCollateralVault"
                />
              </template>
            </div>
          </div>
        </template>
        <template
          v-for="(matrix, matrixIdx) in [matrixMap.get(market.id)]"
          :key="'matrix-' + matrixIdx"
        >
          <div
            v-if="matrix"
            class="border-t border-line-subtle"
            @click="selectedGraphNode?.marketId === market.id && (selectedGraphNode = null)"
          >
            <!-- Controls: view toggle + metric dropdown -->
            <div
              class="px-16 pt-12 pb-8 flex flex-wrap items-center gap-8"
              @click.stop
            >
              <!-- Graph / Matrix toggle -->
              <div class="flex rounded-[100px] border border-line-default overflow-hidden">
                <button
                  class="flex items-center gap-4 min-h-36 py-6 px-12 cursor-pointer transition-all text-p3"
                  :class="getExpandedView(market.id) === 'graph'
                    ? 'bg-accent-300/20 text-accent-700 font-medium'
                    : 'bg-surface text-content-secondary hover:bg-surface-secondary'"
                  @click.stop="setExpandedView(market.id, 'graph')"
                >
                  <UiIcon
                    name="nodes"
                    class="!w-14 !h-14"
                  />
                  Graph
                </button>
                <button
                  class="flex items-center gap-4 min-h-36 py-6 px-12 cursor-pointer transition-all text-p3 border-l border-line-default"
                  :class="getExpandedView(market.id) === 'matrix'
                    ? 'bg-accent-300/20 text-accent-700 font-medium'
                    : 'bg-surface text-content-secondary hover:bg-surface-secondary'"
                  @click.stop="setExpandedView(market.id, 'matrix')"
                >
                  <UiIcon
                    name="grid"
                    class="!w-14 !h-14"
                  />
                  Matrix
                </button>
              </div>

              <!-- Unified matrix view dropdown (matrix view only).
                   Stats / Configuration sit at the top, then Oracles, then
                   the existing pair metrics. Selecting Stats/Configuration
                   swaps in the attribute matrix; everything else uses the
                   pair matrix with the corresponding dotMetric. -->
              <div
                v-if="getExpandedView(market.id) === 'matrix'"
                class="relative"
              >
                <div
                  class="ui-select__field"
                  @click.stop="toggleMatrixDropdown(market.id)"
                >
                  <UiIcon
                    name="filter"
                    class="ui-select__icon"
                  />
                  <span class="ui-select__text">{{ MATRIX_VIEW_OPTIONS.find(o => o.id === getMatrixView(market.id))?.label }}</span>
                  <UiIcon
                    name="arrow-down"
                    class="ui-select__arrow"
                    :style="isMatrixDropdownOpen(market.id) ? 'transform: rotate(180deg)' : ''"
                  />
                </div>
                <div
                  v-if="isMatrixDropdownOpen(market.id)"
                  class="absolute left-0 top-full mt-4 z-50 bg-surface border border-line-default rounded-12 shadow-card py-4 min-w-[180px]"
                >
                  <button
                    v-for="option in MATRIX_VIEW_OPTIONS"
                    :key="option.id"
                    class="w-full text-left px-14 py-6 text-p3 cursor-pointer transition-colors"
                    :class="getMatrixView(market.id) === option.id
                      ? 'text-accent-700 bg-accent-300/20 font-medium'
                      : 'text-content-secondary hover:bg-surface-secondary'"
                    @click.stop="setMatrixView(market.id, option.id)"
                  >
                    {{ option.label }}
                  </button>
                </div>
              </div>

              <UiShareLinkButton
                class="ml-auto !w-28 !h-28"
                :path="`/explore/${market.id}`"
                :query="shareLinkQuery"
                label="Copy market link"
                variant="ghost"
              />
            </div>

            <!-- Graph View -->
            <DiscoveryMarketGraph
              v-if="getExpandedView(market.id) === 'graph'"
              :market="market"
              :diagram="getMiniDiagram(market)"
              :selected-node-address="selectedGraphNode?.marketId === market.id ? selectedGraphNode.address : null"
              @select-node="toggleGraphNode(market.id, $event)"
            />

            <!-- Matrix View: LTV pairs -->
            <DiscoveryMarketMatrix
              v-else-if="getMatrixVariant(market.id) === 'pairs'"
              :market="market"
              :matrix="matrix"
              :dot-metric="getDotMetric(market.id)"
              :selected-cell="selectedCell?.marketId === market.id ? { collateralAddr: selectedCell.collateralAddr, liabilityAddr: selectedCell.liabilityAddr } : null"
              :selected-header="selectedMatrixHeader?.marketId === market.id ? { address: selectedMatrixHeader.address, axis: selectedMatrixHeader.axis } : null"
              @select-cell="(col: string, lia: string) => onCellClick(market.id, col, lia)"
              @select-header="(addr: string, axis: 'row' | 'column') => toggleMatrixHeader(market.id, addr, axis)"
            />

            <!-- Matrix View: Config / Stats attribute matrix -->
            <DiscoveryMarketAttributeMatrix
              v-else-if="attributeMatrixMap.get(market.id)"
              :data="attributeMatrixMap.get(market.id)!"
              :usd-cache="vaultUsdCache"
              :apy-cache="vaultApyCache"
              :selected-header="selectedMatrixHeader?.marketId === market.id ? { address: selectedMatrixHeader.address, axis: selectedMatrixHeader.axis } : null"
              @select-header="(addr: string, axis: 'row' | 'column') => toggleMatrixHeader(market.id, addr, axis)"
            />

            <!-- Vault Cards (below visualization, both views) -->
            <div
              v-if="hasSelection(market)"
              class="border-t border-line-subtle px-16 py-12"
              @click.stop
            >
              <div
                class="rounded-12 border border-accent-500/20 bg-accent-500/[0.04] p-12"
              >
                <!-- Matrix view: cell selection cards -->
                <template v-if="getExpandedView(market.id) === 'matrix'">
                  <!-- Header selection: lend card + multiple borrow pairs -->
                  <template v-if="selectedMatrixHeader?.marketId === market.id">
                    <div class="flex flex-col gap-12">
                      <template
                        v-for="vault in [getMatrixHeaderVault(market)]"
                        :key="'header-lend-' + (vault ? getVaultAddress(vault) : '')"
                      >
                        <template v-if="vault">
                          <h4 class="text-p3 font-medium text-content-secondary">
                            Lend
                          </h4>
                          <VaultItem
                            v-if="isVaultType(vault)"
                            :vault="vault"
                          />
                          <SecuritizeVaultItem
                            v-else
                            :vault="vault as SecuritizeCollateralVault"
                          />
                        </template>
                      </template>

                      <template v-if="getMatrixHeaderBorrowPairs(market).length">
                        <h4 class="text-p3 font-medium text-content-secondary">
                          Borrow
                        </h4>
                      </template>
                      <template
                        v-for="pair in getMatrixHeaderBorrowPairs(market)"
                        :key="`header-borrow-${pair.collateral.address}-${pair.borrow.address}`"
                      >
                        <VaultBorrowItem :pair="pair" />
                      </template>
                    </div>
                  </template>

                  <!-- Cell selection: single lend + single borrow card -->
                  <template v-else>
                    <div class="flex flex-col gap-12">
                      <template
                        v-for="lendVault in [getSelectedLendVault(market)]"
                        :key="'lend-' + (lendVault ? getVaultAddress(lendVault) : '')"
                      >
                        <template v-if="lendVault">
                          <h4 class="text-p3 font-medium text-content-secondary">
                            Lend
                          </h4>
                          <VaultItem
                            v-if="isVaultType(lendVault)"
                            :vault="lendVault"
                          />
                          <SecuritizeVaultItem
                            v-else
                            :vault="lendVault as SecuritizeCollateralVault"
                          />
                        </template>
                      </template>

                      <template
                        v-for="(pair, pairIdx) in [getSelectedBorrowPair(market)]"
                        :key="'borrow-' + pairIdx"
                      >
                        <template v-if="pair">
                          <h4 class="text-p3 font-medium text-content-secondary">
                            Borrow
                          </h4>
                          <VaultBorrowItem :pair="pair" />
                        </template>
                      </template>
                    </div>
                  </template>
                </template>

                <!-- Graph view: node selection cards -->
                <template v-else>
                  <div class="flex flex-col gap-12">
                    <template
                      v-for="vault in [getGraphSelectedVault(market)]"
                      :key="'graph-lend-' + (vault ? getVaultAddress(vault) : '')"
                    >
                      <template v-if="vault">
                        <h4 class="text-p3 font-medium text-content-secondary">
                          Lend
                        </h4>
                        <VaultItem
                          v-if="isVaultType(vault)"
                          :vault="vault"
                        />
                        <SecuritizeVaultItem
                          v-else
                          :vault="vault as SecuritizeCollateralVault"
                        />
                      </template>
                    </template>

                    <template v-if="getGraphBorrowPairs(market).length">
                      <h4 class="text-p3 font-medium text-content-secondary">
                        Borrow
                      </h4>
                    </template>
                    <template
                      v-for="pair in getGraphBorrowPairs(market)"
                      :key="`graph-borrow-${pair.collateral.address}-${pair.borrow.address}`"
                    >
                      <VaultBorrowItem :pair="pair" />
                    </template>

                    <template v-if="getGraphSelectedVault(market) && !getGraphBorrowPairs(market).length">
                      <div class="flex items-center gap-8 px-12 py-10 rounded-8 bg-surface-secondary text-content-tertiary text-p3">
                        <SvgIcon
                          name="info-circle"
                          class="!w-16 !h-16 shrink-0"
                        />
                        <span>This vault is used as collateral only and does not support borrowing.</span>
                      </div>
                    </template>
                  </div>
                </template>
              </div>
            </div>
          </div>
        </template>
      </template>
    </article>
  </div>
</template>
