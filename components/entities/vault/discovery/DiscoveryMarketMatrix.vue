<script setup lang="ts">
import type { CSSProperties } from 'vue'
import type { Address } from 'viem'
import type { MarketGroup } from '~/entities/lend-discovery'
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
import { truncate } from '~/utils/string-utils'

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
  for (const [colAddr, rowCells] of props.matrix.cells) {
    for (const [liabAddr] of rowCells) {
      const collateral = findVault(props.market, colAddr)
      const liability = findVault(props.market, liabAddr)
      if (!collateral || !liability) continue
      if (!isVaultType(liability) || !liability.oracleDetailedInfo) continue
      const adapters = collectOracleAdapters(liability.oracleDetailedInfo, 3, {
        base: collateral.asset.address as Address,
        quote: liability.unitOfAccount as Address,
        leafOnly: true,
      })
      if (adapters.length) result.set(`${colAddr}:${liabAddr}`, adapters)
    }
  }
  return result
})

// Bulk-load adapter metadata for the chain whenever the oracle metric is the
// active view. Heavy call; deferred to first oracle-mode render and cached
// per-chain by useEulerLabels.
watch(
  [() => props.dotMetric, chainId],
  ([metric, currentChainId]) => {
    if (metric !== 'oracle' || !currentChainId) return
    void loadAllOracleAdapters(currentChainId)
  },
  { immediate: true },
)

interface AdapterView {
  oracle: string
  name: string
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

const TOOLTIP_WIDTH = 360
const tooltipAdapter = ref<AdapterView | null>(null)
const tooltipStyle = ref<CSSProperties>({})

const closeTooltip = () => {
  tooltipAdapter.value = null
}

const onAdapterClick = (adapter: AdapterView, event: MouseEvent) => {
  if (tooltipAdapter.value?.oracle === adapter.oracle) {
    closeTooltip()
    return
  }
  const rect = (event.currentTarget as HTMLElement).getBoundingClientRect()
  const left = Math.max(8, Math.min(rect.left, window.innerWidth - TOOLTIP_WIDTH - 16))
  const spaceBelow = Math.max(160, window.innerHeight - rect.bottom - 16)
  const spaceAbove = Math.max(160, rect.top - 16)
  const flipUp = spaceAbove > spaceBelow
  tooltipStyle.value = flipUp
    ? { top: `${rect.top - 8}px`, left: `${left}px`, transform: 'translateY(-100%)', maxHeight: `${spaceAbove}px` }
    : { top: `${rect.bottom + 8}px`, left: `${left}px`, transform: 'none', maxHeight: `${spaceBelow}px` }
  tooltipAdapter.value = adapter
}

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
  <div class="px-16 pb-12 flex items-center justify-center">
    <div
      class="relative max-h-[50vh] overflow-auto rounded-8 border border-line-subtle p-12"
    >
      <table class="border-collapse">
        <thead class="sticky top-0 z-20 bg-surface">
          <tr>
            <th
              class="text-left text-p5 text-content-muted font-normal py-6 pr-10 pl-6 sticky left-0 bg-surface z-30 border-b border-r border-white/[0.04]"
            >
              <div class="flex flex-col leading-tight">
                <span>Liability &#8594;</span>
                <span>Collateral &#8595;</span>
              </div>
            </th>
            <th
              v-for="col in matrix.columns"
              :key="col.address"
              class="text-center text-p4 font-medium py-6 px-8 whitespace-nowrap border-b border-r border-white/[0.04] cursor-pointer transition-colors"
              :class="
                selectedHeader?.address === col.address
                  && selectedHeader?.axis === 'column'
                  ? 'text-accent-500 !bg-accent-500/10'
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
          >
            <td
              class="text-p4 font-medium py-6 pr-10 pl-6 whitespace-nowrap sticky left-0 z-10 bg-surface border-b border-r border-white/[0.04] cursor-pointer transition-colors"
              :class="
                selectedHeader?.address === row.address
                  && selectedHeader?.axis === 'row'
                  ? 'text-accent-500 !bg-accent-500/10'
                  : row.category === 'external'
                    ? 'text-content-tertiary hover:bg-white/[0.04]'
                    : 'text-content-primary hover:bg-white/[0.04]'
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
              :class="[
                selectedCell?.collateralAddr === row.address
                  && selectedCell?.liabilityAddr === col.address
                  ? '!bg-accent-500/20'
                  : row.address === col.address
                    ? 'bg-white/[0.03]'
                    : '',
                matrix.cells.get(row.address)?.get(col.address)
                  ? 'cursor-pointer hover:bg-white/[0.06]'
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
              @mouseenter="
                matrix.cells.get(row.address)?.get(col.address)
                  && (hoveredCell = {
                    collateralAddr: row.address,
                    liabilityAddr: col.address,
                  })
              "
              @mouseleave="hoveredCell = null"
              @click.stop="
                matrix.cells.get(row.address)?.get(col.address)
                  && $emit('selectCell', row.address, col.address)
              "
            >
              <template v-if="matrix.cells.get(row.address)?.get(col.address)">
                <!-- Oracle metric: render adapter logos -->
                <template v-if="dotMetric === 'oracle'">
                  <div class="inline-flex items-center justify-center gap-4 flex-wrap">
                    <button
                      v-for="adapter in getCellAdapterViews(row.address, col.address)"
                      :key="adapter.oracle"
                      type="button"
                      class="relative inline-flex items-center justify-center cursor-pointer"
                      :title="adapter.provider"
                      @click.stop="onAdapterClick(adapter, $event)"
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

  <!-- Oracle adapter tooltip -->
  <Teleport to="body">
    <div
      v-if="tooltipAdapter"
      class="fixed z-[9999] bg-surface-secondary border border-line-subtle rounded-xl p-12 shadow-card overflow-y-auto"
      :style="[tooltipStyle, { width: `${TOOLTIP_WIDTH}px` }]"
      @click.stop
    >
      <div class="flex items-center justify-between gap-8 mb-8">
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
          <span class="text-p2 text-content-primary font-medium">{{ tooltipAdapter.provider || 'Unknown' }}</span>
        </div>
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
      <div class="flex flex-col gap-8 text-p3">
        <div class="flex flex-col gap-2">
          <span class="text-content-tertiary">Oracle</span>
          <NuxtLink
            :to="explorerLink(tooltipAdapter.oracle)"
            target="_blank"
            class="text-accent-600 underline hover:text-accent-500"
            @click.stop
          >
            {{ tooltipAdapter.label?.primary ?? truncate(tooltipAdapter.oracle, 6) }}
            <span
              v-if="tooltipAdapter.label?.suffix"
              class="text-content-tertiary ml-2"
            >{{ tooltipAdapter.label.suffix }}</span>
          </NuxtLink>
        </div>
        <div
          v-if="tooltipAdapter.methodology"
          class="flex flex-col gap-2"
        >
          <span class="text-content-tertiary">Methodology</span>
          <span class="text-content-primary">{{ tooltipAdapter.methodology }}</span>
        </div>
        <div
          v-if="tooltipAdapter.checks?.length"
          class="flex flex-col gap-2"
        >
          <span class="text-content-tertiary">Checks</span>
          <span class="flex items-center gap-6">
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
        <div
          v-if="tooltipAdapter.failedChecks.length"
          class="flex flex-col gap-6 border-t border-line-subtle pt-8"
        >
          <div
            v-for="(check, i) in tooltipAdapter.failedChecks"
            :key="`${check.id}-${i}`"
            class="flex items-start gap-6"
          >
            <SvgIcon
              name="warning"
              class="!w-14 !h-14 mt-1 flex-shrink-0"
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
    </div>
  </Teleport>
</template>
