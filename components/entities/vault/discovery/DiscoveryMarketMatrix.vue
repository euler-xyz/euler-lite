<script setup lang="ts">
import type { CSSProperties } from 'vue'
import type { Address } from 'viem'
import type { MarketGroup } from '~/entities/lend-discovery'
import type { Vault, SecuritizeVault } from '~/entities/vault'
import { nanoToValue } from '~/utils/crypto-utils'
import { getMaxMultiplier, getMaxRoe } from '~/utils/leverage'
import {
  findVault,
  formatMetricValue,
  getCellBgColor,
  isLiquidationLTVRamping,
  getCurrentLiquidationLTV,
  getVaultUtilization,
  isVaultType,
  isMatrixCompatibleVault,
  type CollateralMatrixData,
  type MatrixCell,
  type DotMetric,
  type EnhancedCellApys,
} from '~/utils/discoveryCalculations'
import {
  collectOracleAdapters,
  getChecksStatus,
  OracleAdapterCheckSeverity,
  type OracleAdapterEntry,
  type OracleAdapterCheck,
} from '~/entities/oracle'
import { getOracleProviderLogo } from '~/entities/oracle-providers'
import { getExplorerLink } from '~/utils/block-explorer'
import { truncate, formatNumber } from '~/utils/string-utils'
import { useOracleAdapterPrices } from '~/composables/useOracleAdapterPrices'

const props = defineProps<{
  market: MarketGroup
  matrix: CollateralMatrixData
  dotMetric: DotMetric
  selectedCell: { collateralAddr: string, liabilityAddr: string } | null
  selectedHeader: { address: string, axis: 'row' | 'column' } | null
}>()

defineEmits<{
  selectCell: [collateralAddr: string, liabilityAddr: string]
  selectHeader: [address: string, axis: 'row' | 'column']
}>()

const { withIntrinsicSupplyApy, withIntrinsicBorrowApy } = useIntrinsicApy()
const {
  getBorrowRewardApy,
  getSupplyRewardApy,
  getLoopingRewardApy,
  hasSupplyRewards,
  hasBorrowRewards,
} = useRewardsApy()
const { oracleAdapters, loadAllOracleAdapters } = useEulerLabels()
const { chainId } = useEulerAddresses()

const hoveredCell = ref<{
  collateralAddr: string
  liabilityAddr: string
} | null>(null)

// Row/column highlighting helpers — make it easy to scan a cell back to its
// row label and column header. A row is "highlighted" when it owns either
// the hovered cell or the currently selected cell; same for columns.
const isRowHighlighted = (rowAddr: string): boolean =>
  hoveredCell.value?.collateralAddr === rowAddr
  || props.selectedCell?.collateralAddr === rowAddr

const isColumnHighlighted = (colAddr: string): boolean =>
  hoveredCell.value?.liabilityAddr === colAddr
  || props.selectedCell?.liabilityAddr === colAddr

const computeEnhancedApys = (
  cell: MatrixCell,
  collateralAddr: string,
  liabilityAddr: string,
): EnhancedCellApys => {
  const collateral = findVault(props.market, collateralAddr)
  const liability = findVault(props.market, liabilityAddr)

  let supplyApy = 0
  let supplyRewards = 0
  if (collateral) {
    const base = nanoToValue(collateral.interestRateInfo.supplyAPY, 25)
    supplyApy = withIntrinsicSupplyApy(base, collateral.asset.address)
    supplyRewards = getSupplyRewardApy(collateral.address)
  }

  let borrowApy = 0
  let utilization = 0
  let borrowRewards = 0
  if (liability) {
    const base = nanoToValue(liability.interestRateInfo.borrowAPY, 25)
    borrowApy = withIntrinsicBorrowApy(base, liability.asset.address)
    borrowRewards = getBorrowRewardApy(liability.address, collateral?.address)
    utilization = getVaultUtilization(liability)
  }

  const loopingRewards = liability ? getLoopingRewardApy(liability.address, collateral?.address) : 0

  const supplyFinal = supplyApy + supplyRewards
  const borrowFinal = borrowApy - borrowRewards
  const netApy = supplyFinal - borrowFinal + loopingRewards
  const multiplier = getMaxMultiplier(cell.ltv.borrowLTV)
  const roe = getMaxRoe(multiplier, supplyFinal, borrowFinal, loopingRewards)

  return {
    supplyApy: supplyFinal,
    borrowApy: borrowFinal,
    netApy,
    roe,
    utilization,
  }
}

const getCellMetricValue = (
  cell: MatrixCell,
  collateralAddr: string,
  liabilityAddr: string,
): number => {
  switch (props.dotMetric) {
    case 'bltv':
      return Number(nanoToValue(cell.ltv.borrowLTV, 2))
    case 'lltv':
      return Number(nanoToValue(getCurrentLiquidationLTV(cell.ltv), 2))
    case 'multiplier':
      return getMaxMultiplier(cell.ltv.borrowLTV)
    case 'net-apy':
      return computeEnhancedApys(cell, collateralAddr, liabilityAddr).netApy
    case 'roe':
      return computeEnhancedApys(cell, collateralAddr, liabilityAddr).roe
    default:
      return 0
  }
}

const shouldShowSparkles = (
  collateralAddr: string,
  liabilityAddr: string,
): boolean => {
  if (props.dotMetric !== 'net-apy' && props.dotMetric !== 'roe') return false
  const collateral = findVault(props.market, collateralAddr)
  const liability = findVault(props.market, liabilityAddr)
  const hasSupplyRewardsForCell = collateral
    ? hasSupplyRewards(collateral.address)
    : false
  const hasBorrowRewardsForCell = liability
    ? hasBorrowRewards(liability.address, collateral?.address)
    : false
  return hasSupplyRewardsForCell || hasBorrowRewardsForCell
}

const metricRange = computed((): { min: number, max: number } => {
  if (props.dotMetric === 'oracle') return { min: 0, max: 0 }
  let min = Infinity
  let max = -Infinity
  for (const [rowAddr, cols] of props.matrix.cells) {
    for (const [colAddr, cell] of cols) {
      const v = getCellMetricValue(cell, rowAddr, colAddr)
      if (Number.isFinite(v)) {
        if (v < min) min = v
        if (v > max) max = v
      }
    }
  }
  return Number.isFinite(min) ? { min, max } : { min: 0, max: 0 }
})

// ── Oracle metric: per-cell adapter list + tooltip ────────────────────────────

const cellOracleAdapters = computed((): Map<string, OracleAdapterEntry[]> => {
  const result = new Map<string, OracleAdapterEntry[]>()
  if (props.dotMetric !== 'oracle') return result

  // Skip the ERC4626 wrapper adapter for any address that already appears
  // as a collateral row — the matrix already names the collateral, so the
  // wrapper-to-underlying hop is noise in the cell.
  const skipERC4626Bases = new Set<string>()
  for (const row of props.matrix.rows) skipERC4626Bases.add(row.address.toLowerCase())

  for (const [colAddr, rowCells] of props.matrix.cells) {
    for (const [liabAddr] of rowCells) {
      const collateral = findVault(props.market, colAddr)
      const liability = findVault(props.market, liabAddr)
      if (!collateral || !liability) continue
      if (!isMatrixCompatibleVault(collateral)) continue
      if (!isVaultType(liability) || !liability.oracleDetailedInfo) continue
      // The borrow vault's oracle resolves the collateral *vault* (eToken)
      // address against its unit of account — not the collateral's underlying
      // asset. Mirrors VaultOverviewBlockOracleAdapters' collateralVaults path.
      const adapters = collectOracleAdapters(liability.oracleDetailedInfo, 3, {
        base: collateral.address as Address,
        quote: liability.unitOfAccount as Address,
        leafOnly: true,
        skipERC4626Bases,
      })
      if (adapters.length) result.set(`${colAddr}:${liabAddr}`, adapters)
    }
  }
  return result
})

// Per-borrow-vault asset oracle: resolves the borrow vault's own asset against
// its unit of account. Same set repeated across every cell in a column, so we
// surface it once as a header row instead.
const columnAssetOracleAdapters = computed((): Map<string, OracleAdapterEntry[]> => {
  const result = new Map<string, OracleAdapterEntry[]>()
  if (props.dotMetric !== 'oracle') return result
  for (const col of props.matrix.columns) {
    const liability = findVault(props.market, col.address)
    if (!liability || !isVaultType(liability) || !liability.oracleDetailedInfo) continue
    const adapters = collectOracleAdapters(liability.oracleDetailedInfo, 3, {
      base: liability.asset.address as Address,
      quote: liability.unitOfAccount as Address,
      leafOnly: true,
    })
    if (adapters.length) result.set(col.address, adapters)
  }
  return result
})

// Bulk-load adapter metadata for the chain. Heavy call (1+ MB JSON); the
// `metric !== 'oracle'` guard short-circuits the immediate run on mount and
// every re-evaluation while a non-oracle metric is selected — so the network
// request only fires the first time the user picks the Oracles view.
// loadAllOracleAdapters is per-chain idempotent (cached by useEulerLabels).
watch(
  [() => props.dotMetric, chainId],
  ([metric, currentChainId]) => {
    if (metric !== 'oracle' || !currentChainId) return
    void loadAllOracleAdapters(currentChainId)
  },
  { immediate: true },
)

interface AdapterView {
  oracle: Address
  name: string
  base: Address
  quote: Address
  provider: string
  methodology?: string
  logo?: string
  label?: { primary: string, suffix?: string }
  checks?: OracleAdapterCheck[]
  checksStatus: 'positive' | 'warning' | 'negative' | null
  failedChecks: OracleAdapterCheck[]
}

const enrichAdapter = (adapter: OracleAdapterEntry): AdapterView => {
  const meta = oracleAdapters[adapter.oracle.toLowerCase()]
  const isERC4626 = adapter.name === 'ERC4626Vault'
  const provider = meta?.provider || adapter.name
  const name = meta?.name || adapter.name
  const checks = meta?.checks
  return {
    oracle: adapter.oracle,
    name,
    base: adapter.base,
    quote: adapter.quote,
    provider,
    methodology: meta?.methodology || (isERC4626 ? 'Exchange Rate' : undefined),
    logo: getOracleProviderLogo(provider, name),
    label: meta?.label
      ? {
          primary: meta.label.split('(')[0].trimEnd(),
          suffix: meta.label.includes('(') ? meta.label.slice(meta.label.indexOf('(')).trim() : undefined,
        }
      : undefined,
    checks,
    checksStatus: getChecksStatus(checks),
    failedChecks: checks?.filter(c => !c.pass) ?? [],
  }
}

const getCellAdapterViews = (collateralAddr: string, liabilityAddr: string): AdapterView[] => {
  const list = cellOracleAdapters.value.get(`${collateralAddr}:${liabilityAddr}`)
  if (!list) return []
  return list.map(enrichAdapter)
}

const getColumnAssetAdapterViews = (liabilityAddr: string): AdapterView[] => {
  const list = columnAssetOracleAdapters.value.get(liabilityAddr)
  if (!list) return []
  return list.map(enrichAdapter)
}

const TOOLTIP_WIDTH = 360

interface TooltipContext {
  view: AdapterView
  sourceVault: Vault
  collateralVault: Vault | SecuritizeVault | null
}

const tooltipContext = ref<TooltipContext | null>(null)
const tooltipAdapter = computed(() => tooltipContext.value?.view ?? null)
const tooltipStyle = ref<CSSProperties>({})

// Single matrix-wide price fetch — when oracle mode is active we
// dedup-collect every adapter currently shown (per-pair + per-column-asset)
// and run them through one batchSimulation. The tooltip then reads its
// price from the same map, and every logo can show a warning marker if
// its getQuote reverted.
const adapterKeyOf = (a: OracleAdapterEntry) =>
  `${a.oracle.toLowerCase()}:${a.base.toLowerCase()}:${a.quote.toLowerCase()}`

const allOracleAdapters = computed<OracleAdapterEntry[]>(() => {
  if (props.dotMetric !== 'oracle') return []
  const seen = new Map<string, OracleAdapterEntry>()
  const ingest = (lists: Iterable<OracleAdapterEntry[]>) => {
    for (const list of lists) {
      for (const a of list) {
        const key = adapterKeyOf(a)
        if (!seen.has(key)) seen.set(key, a)
      }
    }
  }
  ingest(cellOracleAdapters.value.values())
  ingest(columnAssetOracleAdapters.value.values())
  return [...seen.values()]
})

const oraclePriceSourceVaults = computed<Vault[]>(() => {
  if (props.dotMetric !== 'oracle') return []
  const seen = new Map<string, Vault>()
  for (const col of props.matrix.columns) {
    const liability = findVault(props.market, col.address)
    if (liability && isVaultType(liability)) {
      seen.set(liability.address.toLowerCase(), liability)
    }
  }
  return [...seen.values()]
})

const oraclePriceCollateralVaults = computed<(Vault | SecuritizeVault)[]>(() => {
  if (props.dotMetric !== 'oracle') return []
  const seen = new Map<string, Vault | SecuritizeVault>()
  for (const row of props.matrix.rows) {
    const v = findVault(props.market, row.address)
    if (v && isMatrixCompatibleVault(v)) {
      seen.set(row.address.toLowerCase(), v)
    }
  }
  return [...seen.values()]
})

const { prices: oraclePrices, isLoading: oraclePricesLoading } = useOracleAdapterPrices(
  allOracleAdapters,
  oraclePriceSourceVaults,
  oraclePriceCollateralVaults,
)

const isAdapterPriceFailed = (adapter: { oracle: string, base: string, quote: string }): boolean => {
  if (oraclePricesLoading.value) return false
  const key = `${adapter.oracle.toLowerCase()}:${adapter.base.toLowerCase()}:${adapter.quote.toLowerCase()}`
  const info = oraclePrices.value.get(key)
  return info ? !info.success : false
}

const tooltipPriceText = computed((): string | null => {
  const ctx = tooltipContext.value
  if (!ctx) return null
  const key = `${ctx.view.oracle.toLowerCase()}:${ctx.view.base.toLowerCase()}:${ctx.view.quote.toLowerCase()}`
  const info = oraclePrices.value.get(key)
  if (!info?.success) return null
  return formatNumber(info.rate, 4)
})

const tooltipPriceLoading = computed(() => oraclePricesLoading.value && !oraclePrices.value.size)

const closeTooltip = () => {
  tooltipContext.value = null
}

const positionTooltip = (event: MouseEvent) => {
  const rect = (event.currentTarget as HTMLElement).getBoundingClientRect()
  const left = Math.max(8, Math.min(rect.left, window.innerWidth - TOOLTIP_WIDTH - 16))
  const spaceBelow = Math.max(160, window.innerHeight - rect.bottom - 16)
  const spaceAbove = Math.max(160, rect.top - 16)
  const flipUp = spaceAbove > spaceBelow
  tooltipStyle.value = flipUp
    ? { top: `${rect.top - 8}px`, left: `${left}px`, transform: 'translateY(-100%)', maxHeight: `${spaceAbove}px` }
    : { top: `${rect.bottom + 8}px`, left: `${left}px`, transform: 'none', maxHeight: `${spaceBelow}px` }
}

const onCellAdapterClick = (
  view: AdapterView,
  event: MouseEvent,
  collateralAddr: string,
  liabilityAddr: string,
) => {
  if (tooltipContext.value?.view.oracle === view.oracle) {
    closeTooltip()
    return
  }
  const liability = findVault(props.market, liabilityAddr)
  const collateral = findVault(props.market, collateralAddr)
  if (!liability || !isVaultType(liability)) return
  positionTooltip(event)
  tooltipContext.value = {
    view,
    sourceVault: liability,
    collateralVault: collateral && collateral.address.toLowerCase() !== liabilityAddr.toLowerCase() ? collateral : null,
  }
}

const onAssetAdapterClick = (
  view: AdapterView,
  event: MouseEvent,
  liabilityAddr: string,
) => {
  if (tooltipContext.value?.view.oracle === view.oracle) {
    closeTooltip()
    return
  }
  const liability = findVault(props.market, liabilityAddr)
  if (!liability || !isVaultType(liability)) return
  positionTooltip(event)
  tooltipContext.value = {
    view,
    sourceVault: liability,
    collateralVault: null,
  }
}

// Document-level bubble-phase listener — `@click.stop` on every logo button
// and on the tooltip itself prevents this from firing for in-tooltip clicks
// or for clicks on other adapter triggers. That keeps "click same logo to
// close" working (vueuse's onClickOutside attaches in capture phase, which
// would short-circuit the toggle behaviour).
const onDocumentClick = () => closeTooltip()
onMounted(() => {
  document.addEventListener('click', onDocumentClick)
})
onUnmounted(() => {
  document.removeEventListener('click', onDocumentClick)
})

const explorerLink = (address: string) => getExplorerLink(address, chainId.value, true)
</script>

<template>
  <div
    class="px-16 pb-12 flex items-center justify-center"
    data-id="collateral-matrix"
    :data-field="dotMetric"
    :data-row-count="matrix.rows.length"
    :data-column-count="matrix.columns.length"
  >
    <div
      class="relative max-h-[50vh] overflow-auto rounded-8 border border-line-subtle px-12 pb-12 pt-0"
    >
      <table class="border-separate border-spacing-0">
        <thead class="sticky top-0 z-30 bg-surface">
          <tr>
            <th
              class="text-left text-p5 text-content-muted font-normal py-6 pr-10 pl-6 sticky left-0 bg-surface z-40 border-b border-r border-white/[0.04]"
            >
              <div class="flex flex-col leading-tight">
                <span>Liability &#8594;</span>
                <span>Collateral &#8595;</span>
              </div>
            </th>
            <th
              v-for="col in matrix.columns"
              :key="col.address"
              class="text-center text-p4 font-medium py-6 px-8 whitespace-nowrap bg-surface border-b border-r border-white/[0.04] cursor-pointer transition-colors"
              data-id="collateral-matrix-column"
              :data-key="col.address"
              :data-vault-address="col.address"
              :class="
                selectedHeader?.address === col.address
                  && selectedHeader?.axis === 'column'
                  ? 'text-accent-500 !bg-accent-500/10'
                  : isColumnHighlighted(col.address)
                    ? 'text-content-primary !bg-white/[0.06]'
                    : 'text-content-primary hover:bg-white/[0.04]'
              "
              @click.stop="$emit('selectHeader', col.address, 'column')"
            >
              <div class="flex flex-col items-center gap-2">
                <AssetAvatar
                  :asset="{ address: col.assetAddress, symbol: col.symbol }"
                  size="16"
                />
                {{ col.symbol }}
              </div>
            </th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="row in matrix.rows"
            :key="row.address"
            data-id="collateral-matrix-row"
            :data-key="row.address"
            :data-vault-address="row.address"
          >
            <td
              class="text-p4 font-medium py-6 pr-10 pl-6 whitespace-nowrap sticky left-0 z-10 bg-surface border-b border-r border-white/[0.04] cursor-pointer transition-colors"
              data-id="collateral-matrix-row-header"
              :data-key="row.address"
              :data-vault-address="row.address"
              :class="
                selectedHeader?.address === row.address
                  && selectedHeader?.axis === 'row'
                  ? 'text-accent-500 !bg-accent-500/10'
                  : isRowHighlighted(row.address)
                    ? (row.category !== 'borrowable' ? 'text-content-tertiary !bg-white/[0.06]' : 'text-content-primary !bg-white/[0.06]')
                    : (row.category !== 'borrowable'
                      ? 'text-content-tertiary hover:bg-white/[0.04]'
                      : 'text-content-primary hover:bg-white/[0.04]')
              "
              @click.stop="$emit('selectHeader', row.address, 'row')"
            >
              <div class="flex items-center gap-4">
                <AssetAvatar
                  class="shrink-0"
                  :asset="{ address: row.assetAddress, symbol: row.symbol }"
                  size="16"
                />
                {{ row.symbol }}
              </div>
            </td>
            <td
              v-for="col in matrix.columns"
              :key="col.address"
              class="text-center py-6 px-8 min-w-[56px] transition-colors border-b border-r border-white/[0.04]"
              data-id="collateral-matrix-cell"
              :data-key="`${row.address}:${col.address}`"
              :data-collateral-address="row.address"
              :data-borrow-address="col.address"
              :data-field="dotMetric"
              :data-present="!!matrix.cells.get(row.address)?.get(col.address)"
              :data-value="matrix.cells.get(row.address)?.get(col.address) ? getCellMetricValue(matrix.cells.get(row.address)!.get(col.address)!, row.address, col.address) : undefined"
              :class="[
                selectedCell?.collateralAddr === row.address
                  && selectedCell?.liabilityAddr === col.address
                  ? '!bg-accent-500/20'
                  : (isRowHighlighted(row.address) || isColumnHighlighted(col.address))
                    ? '!bg-white/[0.06]'
                    : row.address === col.address
                      ? 'bg-white/[0.03]'
                      : '',
                matrix.cells.get(row.address)?.get(col.address)
                  ? 'cursor-pointer'
                  : '',
              ]"
              :style="
                (() => {
                  const cell = matrix.cells.get(row.address)?.get(col.address);
                  if (!cell) return undefined;
                  if (
                    selectedCell?.collateralAddr === row.address
                    && selectedCell?.liabilityAddr === col.address
                  )
                    return undefined;
                  if (row.address === col.address) return undefined;

                  const val = getCellMetricValue(
                    cell,
                    row.address,
                    col.address,
                  );
                  return {
                    backgroundColor: getCellBgColor(
                      val,
                      dotMetric,
                      metricRange.min,
                      metricRange.max,
                    ),
                  };
                })()
              "
              @mouseenter="hoveredCell = { collateralAddr: row.address, liabilityAddr: col.address }"
              @mouseleave="hoveredCell = null"
              @click.stop="
                matrix.cells.get(row.address)?.get(col.address)
                  && $emit('selectCell', row.address, col.address)
              "
            >
              <!-- Diagonal in oracle mode: surface the borrow vault's own
                   asset -> UoA oracle (same for every cell in the column,
                   so we show it once on the self-row instead of repeating). -->
              <template
                v-if="dotMetric === 'oracle'
                  && row.address === col.address
                  && getColumnAssetAdapterViews(col.address).length"
              >
                <div class="inline-flex items-center justify-center gap-4 flex-wrap">
                  <button
                    v-for="adapter in getColumnAssetAdapterViews(col.address)"
                    :key="adapter.oracle"
                    type="button"
                    class="relative inline-flex items-center justify-center cursor-pointer"
                    data-id="oracle-adapter"
                    :data-key="`${col.address}:${adapter.oracle}:${adapter.base}:${adapter.quote}`"
                    :data-borrow-address="col.address"
                    :data-oracle-address="adapter.oracle"
                    :data-base-address="adapter.base"
                    :data-quote-address="adapter.quote"
                    :title="adapter.provider"
                    @click.stop="onAssetAdapterClick(adapter, $event, col.address)"
                  >
                    <BaseAvatar
                      v-if="adapter.logo"
                      :src="adapter.logo"
                      :label="adapter.name"
                      class="icon--16"
                    />
                    <SvgIcon
                      v-else
                      name="question-circle"
                      class="!w-16 !h-16 text-content-tertiary"
                    />
                    <span
                      v-if="adapter.checksStatus === 'warning' || adapter.checksStatus === 'negative'"
                      class="absolute -top-1 -right-1 w-6 h-6 rounded-full"
                      :class="adapter.checksStatus === 'negative' ? 'bg-error-500' : 'bg-warning-500'"
                    />
                    <SvgIcon
                      v-if="isAdapterPriceFailed(adapter)"
                      name="warning"
                      class="absolute -bottom-1 -right-1 !w-10 !h-10 text-warning-500"
                      title="getQuote reverted"
                    />
                  </button>
                </div>
              </template>

              <template v-else-if="matrix.cells.get(row.address)?.get(col.address)">
                <!-- Oracle metric: render adapter logos -->
                <template v-if="dotMetric === 'oracle'">
                  <div class="inline-flex items-center justify-center gap-4 flex-wrap">
                    <button
                      v-for="adapter in getCellAdapterViews(row.address, col.address)"
                      :key="adapter.oracle"
                      type="button"
                      class="relative inline-flex items-center justify-center cursor-pointer"
                      data-id="oracle-adapter"
                      :data-key="`${row.address}:${col.address}:${adapter.oracle}:${adapter.base}:${adapter.quote}`"
                      :data-collateral-address="row.address"
                      :data-borrow-address="col.address"
                      :data-oracle-address="adapter.oracle"
                      :data-base-address="adapter.base"
                      :data-quote-address="adapter.quote"
                      :title="adapter.provider"
                      @click.stop="onCellAdapterClick(adapter, $event, row.address, col.address)"
                    >
                      <BaseAvatar
                        v-if="adapter.logo"
                        :src="adapter.logo"
                        :label="adapter.name"
                        class="icon--16"
                      />
                      <SvgIcon
                        v-else
                        name="question-circle"
                        class="!w-16 !h-16 text-content-tertiary"
                      />
                      <span
                        v-if="adapter.checksStatus === 'warning' || adapter.checksStatus === 'negative'"
                        class="absolute -top-1 -right-1 w-6 h-6 rounded-full"
                        :class="adapter.checksStatus === 'negative' ? 'bg-error-500' : 'bg-warning-500'"
                      />
                      <SvgIcon
                        v-if="isAdapterPriceFailed(adapter)"
                        name="warning"
                        class="absolute -bottom-1 -right-1 !w-10 !h-10 text-warning-500"
                        title="getQuote reverted"
                      />
                    </button>
                  </div>
                </template>

                <!-- Numeric metrics: original rendering -->
                <div
                  v-else
                  class="inline-flex items-center justify-center gap-2"
                >
                  <SvgIcon
                    v-if="
                      dotMetric === 'lltv'
                        && isLiquidationLTVRamping(
                          matrix.cells.get(row.address)!.get(col.address)!.ltv,
                        )
                    "
                    name="arrow-top-right"
                    class="!w-10 !h-10 text-warning-500 shrink-0 rotate-180"
                    title="Liquidation LTV ramping down"
                  />
                  <SvgIcon
                    v-if="shouldShowSparkles(row.address, col.address)"
                    name="sparks"
                    class="!w-10 !h-10 text-accent-500 shrink-0"
                  />
                  <span
                    class="text-p5 whitespace-nowrap transition-all"
                    :class="[
                      selectedCell?.collateralAddr === row.address
                        && selectedCell?.liabilityAddr === col.address
                        ? 'text-accent-500 font-semibold'
                        : hoveredCell?.collateralAddr === row.address
                          && hoveredCell?.liabilityAddr === col.address
                          ? 'text-content-primary font-medium'
                          : 'text-content-secondary',
                    ]"
                  >
                    {{
                      formatMetricValue(
                        getCellMetricValue(
                          matrix.cells.get(row.address)!.get(col.address)!,
                          row.address,
                          col.address,
                        ),
                        dotMetric,
                      )
                    }}
                  </span>
                </div>
              </template>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>

  <p
    v-if="!selectedCell && !selectedHeader"
    class="text-h6 text-content-primary text-center leading-relaxed px-16 pb-12"
  >
    Tap a cell, row, or column header to see lending/borrowing options below.
  </p>

  <!-- Oracle adapter tooltip — mirrors VaultOverviewBlockOracleAdapters card layout -->
  <Teleport to="body">
    <div
      v-if="tooltipAdapter"
      class="fixed z-[9999] bg-surface-secondary border border-line-subtle rounded-xl p-16 shadow-card overflow-y-auto flex flex-col gap-12"
      :style="[tooltipStyle, { width: `${TOOLTIP_WIDTH}px` }]"
      @click.stop
    >
      <!-- Header: oracle label / pair + address & close -->
      <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-4 sm:gap-8">
        <div class="text-p2 text-content-primary font-medium">
          <template v-if="tooltipAdapter.label">
            {{ tooltipAdapter.label.primary }}
            <span
              v-if="tooltipAdapter.label.suffix"
              class="text-content-tertiary ml-2"
            >{{ tooltipAdapter.label.suffix }}</span>
          </template>
          <template v-else>
            Oracle
          </template>
        </div>
        <div class="flex items-center gap-8 flex-shrink-0">
          <NuxtLink
            :to="explorerLink(tooltipAdapter.oracle)"
            target="_blank"
            class="text-accent-600 underline cursor-pointer hover:text-accent-500 text-p3"
            @click.stop
          >
            {{ truncate(tooltipAdapter.oracle, 6) }}
          </NuxtLink>
          <button
            type="button"
            class="text-content-muted hover:text-content-secondary cursor-pointer"
            aria-label="Close"
            @click.stop="closeTooltip"
          >
            <SvgIcon
              name="close"
              class="!w-14 !h-14"
            />
          </button>
        </div>
      </div>

      <!-- Provider / Methodology / Price / Checks grid (mirrors borrow page) -->
      <div class="grid grid-cols-2 gap-12 text-p3">
        <div class="flex flex-col gap-4">
          <span class="text-content-tertiary">Provider</span>
          <div class="flex items-center gap-8">
            <BaseAvatar
              v-if="tooltipAdapter.logo"
              :src="tooltipAdapter.logo"
              :label="tooltipAdapter.name"
              class="icon--20"
            />
            <SvgIcon
              v-else
              name="question-circle"
              class="!w-20 !h-20 text-content-tertiary"
            />
            <span class="text-content-primary">{{ tooltipAdapter.provider || 'Unknown' }}</span>
          </div>
        </div>
        <div class="flex flex-col gap-4">
          <span class="text-content-tertiary">Methodology</span>
          <span class="text-content-primary">{{ tooltipAdapter.methodology || 'Unknown' }}</span>
        </div>
        <div class="flex flex-col gap-4">
          <span class="text-content-tertiary">Price</span>
          <span
            v-if="tooltipPriceLoading"
            class="text-content-secondary animate-pulse"
          >...</span>
          <span
            v-else-if="tooltipPriceText === null"
            class="flex items-center text-warning-500"
          >
            <SvgIcon
              name="warning"
              class="mr-2 !w-16 !h-16"
            />
            Unknown
          </span>
          <span
            v-else
            class="text-content-primary"
          >{{ tooltipPriceText }}</span>
        </div>
        <div class="flex flex-col gap-4">
          <span class="text-content-tertiary">Checks</span>
          <span
            v-if="!tooltipAdapter.checks?.length"
            class="text-content-secondary"
          >N/A</span>
          <span
            v-else
            class="flex items-center gap-6"
          >
            <span
              class="inline-block w-8 h-8 rounded-full flex-shrink-0"
              :class="{
                'bg-success-500': tooltipAdapter.checksStatus === 'positive',
                'bg-warning-500': tooltipAdapter.checksStatus === 'warning',
                'bg-error-500': tooltipAdapter.checksStatus === 'negative',
              }"
            />
            <span class="text-content-primary">
              <template v-if="tooltipAdapter.checksStatus === 'positive'">{{ tooltipAdapter.checks.length }} passed</template>
              <template v-else>{{ tooltipAdapter.failedChecks.length }} failed</template>
            </span>
          </span>
        </div>
      </div>

      <!-- Failed checks detail -->
      <div
        v-if="tooltipAdapter.failedChecks.length"
        class="flex flex-col gap-6 border-t border-line-subtle pt-12 text-p3"
      >
        <div
          v-for="(check, i) in tooltipAdapter.failedChecks"
          :key="`${check.id}-${i}`"
          class="flex items-start gap-8"
        >
          <SvgIcon
            name="warning"
            class="!w-16 !h-16 mt-1 flex-shrink-0"
            :class="{
              'text-error-500': check.severity === OracleAdapterCheckSeverity.High,
              'text-warning-500': check.severity !== OracleAdapterCheckSeverity.High,
            }"
          />
          <div>
            <span class="text-content-primary font-medium">{{ check.id }}: </span>
            <span class="text-content-secondary">{{ check.message }}</span>
          </div>
        </div>
      </div>
    </div>
  </Teleport>
</template>
