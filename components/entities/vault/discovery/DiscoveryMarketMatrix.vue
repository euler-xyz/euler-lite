<script setup lang="ts">
import { isEVault } from '@eulerxyz/euler-v2-sdk'
import { getMaxMultiplier, getMaxRoe } from '~/utils/leverage'
import { findVault, formatMetricValue, getCellBgColor, isMatrixCompatibleVault, type CollateralMatrixData, type MatrixCell, type DotMetric, type EnhancedCellApys } from '~/utils/discoveryCalculations'
import { buildOracleAdapterViews, collectOracleRouteSteps, type OracleAdapterView } from '~/utils/oracle-adapter-views'
import type { MarketGroup } from '~/entities/lend-discovery'
import { withVaultIntrinsicApy } from '~/utils/vault-intrinsic-apy'
import { areTokenAddressesCorrelatedByTags } from '~/utils/token-categories'

const props = defineProps<{
  market: MarketGroup
  matrix: CollateralMatrixData
  dotMetric: DotMetric
  selectedCell: { collateralAddr: string, liabilityAddr: string } | null
  selectedHeader: { address: string, axis: 'row' | 'column' } | null
}>()

const emit = defineEmits<{
  selectCell: [collateralAddr: string, liabilityAddr: string]
  selectHeader: [address: string, axis: 'row' | 'column']
}>()

const { settings } = useUserSettings()
const enableIntrinsicApy = computed(() => settings.value.enableIntrinsicApy)
const {
  getBorrowRewardApy,
  getSupplyRewardApy,
  getLoopingRewardApy,
  hasSupplyRewards,
  hasBorrowRewards,
} = useRewardsApy()
const { oracleAdapters, loadAllOracleAdapters } = useEulerLabels()
const { chainId } = useEulerAddresses()
const { getTokenCategoryTags } = useTokenList()

const hoveredCell = ref<{
  collateralAddr: string
  liabilityAddr: string
} | null>(null)

const unavailableRoeCellLabel = 'Max ROE is unavailable for uncorrelated pairs. Compare Net APY instead.'
const unavailableMultiplierCellLabel = 'Max multiplier is unavailable for uncorrelated pairs.'

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
    const base = getVaultSupplyApy(collateral)
    supplyApy = withVaultIntrinsicApy(base, collateral, enableIntrinsicApy.value)
    supplyRewards = getSupplyRewardApy(collateral.address)
  }

  let borrowApy = 0
  let utilization = 0
  let borrowRewards = 0
  if (liability) {
    const base = getVaultBorrowApy(liability)
    borrowApy = withVaultIntrinsicApy(base, liability, enableIntrinsicApy.value)
    borrowRewards = getBorrowRewardApy(liability.address, collateral?.address)
    utilization = isEVault(liability) ? liability.utilization : 0
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

const isCorrelatedCell = (
  collateralAddr: string,
  liabilityAddr: string,
): boolean => {
  const collateral = findVault(props.market, collateralAddr)
  const liability = findVault(props.market, liabilityAddr)
  if (!collateral || !liability) return false
  return areTokenAddressesCorrelatedByTags(
    collateral.asset.address,
    liability.asset.address,
    getTokenCategoryTags,
  )
}

const getCellMetricValue = (
  cell: MatrixCell,
  collateralAddr: string,
  liabilityAddr: string,
): number => {
  switch (props.dotMetric) {
    case 'bltv':
      return Number(ltvToPercent(cell.ltv.borrowLTV))
    case 'lltv':
      return Number(ltvToPercent(cell.ltv.currentLiquidationLTV))
    case 'multiplier':
      return isCorrelatedCell(collateralAddr, liabilityAddr) ? getMaxMultiplier(cell.ltv.borrowLTV) : Number.NaN
    case 'net-apy':
      return computeEnhancedApys(cell, collateralAddr, liabilityAddr).netApy
    case 'roe': {
      const apys = computeEnhancedApys(cell, collateralAddr, liabilityAddr)
      return isCorrelatedCell(collateralAddr, liabilityAddr) ? apys.roe : Number.NaN
    }
    default:
      return 0
  }
}

const isUnavailableRoeCell = (
  collateralAddr: string,
  liabilityAddr: string,
): boolean =>
  props.dotMetric === 'roe'
  && !!props.matrix.cells.get(collateralAddr)?.get(liabilityAddr)
  && !isCorrelatedCell(collateralAddr, liabilityAddr)

const isUnavailableMultiplierCell = (
  collateralAddr: string,
  liabilityAddr: string,
): boolean =>
  props.dotMetric === 'multiplier'
  && !!props.matrix.cells.get(collateralAddr)?.get(liabilityAddr)
  && !isCorrelatedCell(collateralAddr, liabilityAddr)

const getUnavailableMetricLabel = (
  collateralAddr: string,
  liabilityAddr: string,
): string | undefined => {
  if (isUnavailableRoeCell(collateralAddr, liabilityAddr)) return unavailableRoeCellLabel
  if (isUnavailableMultiplierCell(collateralAddr, liabilityAddr)) return unavailableMultiplierCellLabel
  return undefined
}

const isUnavailableMetricCell = (
  collateralAddr: string,
  liabilityAddr: string,
): boolean => getUnavailableMetricLabel(collateralAddr, liabilityAddr) !== undefined

const shouldShowSparkles = (
  collateralAddr: string,
  liabilityAddr: string,
): boolean => {
  if (props.dotMetric !== 'net-apy' && props.dotMetric !== 'roe') return false
  if (props.dotMetric === 'roe' && !isCorrelatedCell(collateralAddr, liabilityAddr)) return false
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

const hasRewardMetricCells = computed((): boolean => {
  if (props.dotMetric !== 'net-apy' && props.dotMetric !== 'roe') return false
  for (const [rowAddr, cols] of props.matrix.cells) {
    for (const colAddr of cols.keys()) {
      if (shouldShowSparkles(rowAddr, colAddr)) return true
    }
  }
  return false
})

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

// ── Oracle metric: per-cell adapter views ────────────────────────────────────

// Each off-diagonal cell shows every oracle adapter that prices the pair's
// collateral AND liability assets — the same set the borrow page's Oracles
// block renders, via the shared collectOracleRouteSteps + buildOracleAdapterViews.
// The self-diagonal is intentionally left blank: a liability's own asset->UoA
// oracle already appears in every cell of its column.
const cellAdapterViews = computed((): Map<string, OracleAdapterView[]> => {
  const result = new Map<string, OracleAdapterView[]>()
  if (props.dotMetric !== 'oracle') return result

  for (const [collateralAddr, rowCells] of props.matrix.cells) {
    for (const [liabilityAddr] of rowCells) {
      if (collateralAddr === liabilityAddr) continue
      const collateral = findVault(props.market, collateralAddr)
      const liability = findVault(props.market, liabilityAddr)
      if (!collateral || !isMatrixCompatibleVault(collateral)) continue
      if (!liability || !isEVault(liability)) continue
      const steps = collectOracleRouteSteps([liability], [collateral])
      if (steps.length) {
        result.set(`${collateralAddr}:${liabilityAddr}`, buildOracleAdapterViews(steps, oracleAdapters))
      }
    }
  }
  return result
})

const getCellAdapterViews = (collateralAddr: string, liabilityAddr: string): OracleAdapterView[] =>
  cellAdapterViews.value.get(`${collateralAddr}:${liabilityAddr}`) ?? []

const isOracleCellSelectable = (collateralAddr: string, liabilityAddr: string): boolean =>
  getCellAdapterViews(collateralAddr, liabilityAddr).length > 0

// Cell click drives the inline oracle detail section below the matrix. In oracle
// mode only off-diagonal cells that actually have adapters are selectable; other
// metrics keep the original "any present cell is selectable" behaviour.
const onCellClick = (collateralAddr: string, liabilityAddr: string) => {
  if (props.dotMetric === 'oracle') {
    if (!isOracleCellSelectable(collateralAddr, liabilityAddr)) return
  }
  else if (!props.matrix.cells.get(collateralAddr)?.get(liabilityAddr)) {
    return
  }
  emit('selectCell', collateralAddr, liabilityAddr)
}

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
</script>

<template>
  <div
    class="px-16 pb-12 flex flex-col items-center justify-center gap-8"
    data-id="collateral-matrix"
    data-list="collateral-matrix"
    :data-key="market.id"
    :data-market-id="market.id"
    :data-field="dotMetric"
    :data-row-count="matrix.rows.length"
    :data-column-count="matrix.columns.length"
  >
    <div
      class="relative isolate max-h-[50vh] overflow-auto rounded-8 border border-line-subtle px-12 pb-12 pt-0"
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
              data-list="collateral-matrix-column"
              :data-key="col.address"
              :data-market-id="market.id"
              :data-vault-address="col.address"
              :class="
                selectedHeader?.address === col.address
                  && selectedHeader?.axis === 'column'
                  ? 'text-accent-500 shadow-[inset_0_0_0_9999px_rgba(var(--accent-rgb),0.10)]'
                  : isColumnHighlighted(col.address)
                    ? (col.isExternal ? 'text-content-tertiary shadow-[inset_0_0_0_9999px_rgba(255,255,255,0.06)]' : 'text-content-primary shadow-[inset_0_0_0_9999px_rgba(255,255,255,0.06)]')
                    : (col.isExternal
                      ? 'text-content-tertiary hover:shadow-[inset_0_0_0_9999px_rgba(255,255,255,0.04)]'
                      : 'text-content-primary hover:shadow-[inset_0_0_0_9999px_rgba(255,255,255,0.04)]')
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
            data-list="collateral-matrix-row"
            :data-key="row.address"
            :data-market-id="market.id"
            :data-vault-address="row.address"
          >
            <td
              class="text-p4 font-medium py-6 pr-10 pl-6 whitespace-nowrap sticky left-0 z-10 bg-surface border-b border-r border-white/[0.04] cursor-pointer transition-colors"
              data-id="collateral-matrix-row-header"
              data-list="collateral-matrix-row-header"
              :data-key="row.address"
              :data-market-id="market.id"
              :data-vault-address="row.address"
              :class="
                selectedHeader?.address === row.address
                  && selectedHeader?.axis === 'row'
                  ? 'text-accent-500 shadow-[inset_0_0_0_9999px_rgba(var(--accent-rgb),0.10)]'
                  : isRowHighlighted(row.address)
                    ? (row.category !== 'borrowable' ? 'text-content-tertiary shadow-[inset_0_0_0_9999px_rgba(255,255,255,0.06)]' : 'text-content-primary shadow-[inset_0_0_0_9999px_rgba(255,255,255,0.06)]')
                    : (row.category !== 'borrowable'
                      ? 'text-content-tertiary hover:shadow-[inset_0_0_0_9999px_rgba(255,255,255,0.04)]'
                      : 'text-content-primary hover:shadow-[inset_0_0_0_9999px_rgba(255,255,255,0.04)]')
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
              data-list="collateral-matrix-cell"
              :data-key="`${row.address}:${col.address}`"
              :data-market-id="market.id"
              :data-collateral-address="row.address"
              :data-borrow-address="col.address"
              :data-field="dotMetric"
              :data-present="!!matrix.cells.get(row.address)?.get(col.address)"
              :data-correlated="matrix.cells.get(row.address)?.get(col.address) ? isCorrelatedCell(row.address, col.address) : undefined"
              :aria-label="getUnavailableMetricLabel(row.address, col.address)"
              :data-value="
                (() => {
                  const cell = matrix.cells.get(row.address)?.get(col.address);
                  if (!cell) return undefined;
                  const value = getCellMetricValue(cell, row.address, col.address);
                  return Number.isFinite(value) ? value : undefined;
                })()
              "
              :class="[
                selectedCell?.collateralAddr === row.address
                  && selectedCell?.liabilityAddr === col.address
                  ? '!bg-accent-500/20'
                  : (isRowHighlighted(row.address) || isColumnHighlighted(col.address))
                    ? '!bg-white/[0.06]'
                    : row.address === col.address
                      ? 'bg-white/[0.03]'
                      : '',
                (dotMetric === 'oracle'
                  ? isOracleCellSelectable(row.address, col.address)
                  : !!matrix.cells.get(row.address)?.get(col.address))
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
                  if (!Number.isFinite(val)) return undefined;
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
              @click.stop="onCellClick(row.address, col.address)"
            >
              <template v-if="matrix.cells.get(row.address)?.get(col.address)">
                <!-- Oracle metric: every adapter pricing the pair's collateral &
                     liability assets. Display-only logos; clicking the cell opens
                     the inline oracle section below the matrix. -->
                <div
                  v-if="dotMetric === 'oracle' && getCellAdapterViews(row.address, col.address).length"
                  class="inline-flex items-center justify-center gap-4 flex-wrap"
                >
                  <span
                    v-for="adapter in getCellAdapterViews(row.address, col.address)"
                    :key="adapter.key"
                    class="relative inline-flex items-center justify-center"
                    data-id="oracle-adapter"
                    :data-key="`${row.address}:${col.address}:${adapter.key}`"
                    :data-collateral-address="row.address"
                    :data-borrow-address="col.address"
                    :data-oracle-address="adapter.oracle"
                    :data-base-address="adapter.base"
                    :data-quote-address="adapter.quote"
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
                      v-if="adapter.checksStatus"
                      class="absolute -top-1 -right-1 w-6 h-6 rounded-full"
                      :class="{
                        'bg-success-500': adapter.checksStatus === 'positive',
                        'bg-warning-500': adapter.checksStatus === 'warning',
                        'bg-error-500': adapter.checksStatus === 'negative',
                      }"
                    />
                  </span>
                </div>

                <!-- Numeric metrics: original rendering -->
                <div
                  v-if="dotMetric !== 'oracle'"
                  class="inline-flex items-center justify-center gap-2"
                >
                  <UiHoverPreviewTooltip
                    v-if="
                      dotMetric === 'lltv'
                        && matrix.cells.get(row.address)!.get(col.address)!.ltv.isLiquidationLTVRamping
                    "
                    title="Liquidation LTV ramping down"
                    text="The Liquidation LTV for this collateral is currently being reduced."
                    placement="top-start"
                  >
                    <SvgIcon
                      name="arrow-top-right"
                      class="!w-10 !h-10 text-warning-500 shrink-0 rotate-180"
                    />
                  </UiHoverPreviewTooltip>
                  <SvgIcon
                    v-if="shouldShowSparkles(row.address, col.address)"
                    name="sparks"
                    class="!w-10 !h-10 text-accent-500 shrink-0"
                  />
                  <span
                    v-if="isUnavailableMetricCell(row.address, col.address)"
                    class="text-p5 whitespace-nowrap text-content-muted"
                  >
                    -
                  </span>
                  <span
                    v-else-if="
                      Number.isFinite(
                        getCellMetricValue(
                          matrix.cells.get(row.address)!.get(col.address)!,
                          row.address,
                          col.address,
                        ),
                      )
                    "
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
                      Number.isFinite(getCellMetricValue(
                        matrix.cells.get(row.address)!.get(col.address)!,
                        row.address,
                        col.address,
                      ))
                        ? formatMetricValue(
                          getCellMetricValue(
                            matrix.cells.get(row.address)!.get(col.address)!,
                            row.address,
                            col.address,
                          ),
                          dotMetric,
                        )
                        : 'N/A'
                    }}
                  </span>
                </div>
              </template>
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <div
      v-if="hasRewardMetricCells"
      class="flex flex-wrap items-center justify-center gap-x-10 gap-y-4 text-p5 text-content-muted"
      data-id="collateral-matrix-legend"
    >
      <span
        v-if="hasRewardMetricCells"
        class="inline-flex items-center gap-3 whitespace-nowrap"
      >
        <SvgIcon
          name="sparks"
          class="!w-10 !h-10 text-accent-500 shrink-0"
        />
        Rewards included
      </span>
    </div>
  </div>

  <p
    v-if="!selectedCell && !selectedHeader"
    class="text-h6 text-content-primary text-center leading-relaxed px-16 pb-12"
  >
    Tap a cell, row, or column header to see lending/borrowing options below.
  </p>
</template>
