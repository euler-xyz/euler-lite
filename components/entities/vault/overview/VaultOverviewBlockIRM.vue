<script setup lang="ts">
import { Line } from 'vue-chartjs'
import {
  Chart as ChartJS,
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  Title,
  Tooltip,
  Legend,
  Filler,
  type ChartOptions,
  type ChartData,
} from 'chart.js'
import annotationPlugin from 'chartjs-plugin-annotation'
import { formatUnits, zeroAddress, decodeAbiParameters, type Address, type Abi, type Hex } from 'viem'
import { logWarn } from '~/utils/errorHandling'
import {
  INTEREST_RATE_MODEL_TYPE,
  KINK_IRM_COMPONENTS,
  ADAPTIVE_CURVE_IRM_COMPONENTS,
  KINKY_IRM_COMPONENTS,
} from '~/entities/constants'
import {
  type Vault,
  type SecuritizeVault,
  type KinkIRMParams,
  type AdaptiveCurveIRMParams,
  type KinkyIRMParams,
  getVaultUtilization,
  hasCollateralExposure,
} from '~/entities/vault'
import { useVaultRegistry } from '~/composables/useVaultRegistry'
import { eulerVaultLensABI } from '~/entities/euler/abis'

// Register Chart.js components
ChartJS.register(
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  Title,
  Tooltip,
  Legend,
  Filler,
  annotationPlugin,
)

const { vault } = defineProps<{ vault: Vault }>()

const chartData = ref<ChartData<'line'> | null>(null)
const chartOptions = ref<ChartOptions<'line'> | null>(null)
const isLoading = ref(true)
const hasError = ref(false)

// Theme-aware chart colors (reads from CSS variables)
const { getChartColors, isDark } = useThemeColors()

const { client: rpcClient } = useRpcClient()
const { eulerLensAddresses } = useEulerAddresses()
const { get: registryGet } = useVaultRegistry()

// Only render the IRM chart for vaults that have live borrow-side exposure —
// either currently borrowable, or still accruing interest on existing debt
// while the liquidation LTV ramps down. This mirrors the visibility rule of
// the "Collateral exposure" block and correctly excludes collateral-only
// vaults that may still carry a non-zero interestRateModelAddress.
const hasValidIRM = computed(() => {
  const hasExposure = hasCollateralExposure(
    vault,
    addr => registryGet(addr)?.vault as Vault | SecuritizeVault | undefined,
  )
  return hasExposure
    && vault.interestRateModelAddress
    && vault.interestRateModelAddress !== zeroAddress
})

const SECONDS_PER_YEAR = 31_557_600 // 365.25 days
const MAX_UINT32 = 4_294_967_295

// Key borrow APY values derived from the chart data (populated in renderChart)
const chartRateAtZero = ref<number | null>(null)
const chartRateAtKink = ref<number | null>(null)
const chartRateAtMax = ref<number | null>(null)

const formatKinkPercent = (kink: bigint): string => {
  const percent = Number(kink) / MAX_UINT32 * 100
  return `${percent.toFixed(2)}%`
}

const formatWadPercent = (wad: bigint): string => {
  const percent = Number(formatUnits(wad, 18)) * 100
  return `${percent.toFixed(2)}%`
}

const formatWadPerSecToApy = (wadPerSec: bigint): string => {
  const apy = Number(formatUnits(wadPerSec, 18)) * SECONDS_PER_YEAR * 100
  return `${apy.toFixed(2)}%`
}

const irmModelType = computed(() => Number(vault.irmInfo?.interestRateModelInfo?.interestRateModelType))

const irmTypeLabel = computed(() => {
  const type = irmModelType.value
  if (type === INTEREST_RATE_MODEL_TYPE.KINK) return 'Kink'
  if (type === INTEREST_RATE_MODEL_TYPE.ADAPTIVE_CURVE) return 'Adaptive'
  if (type === INTEREST_RATE_MODEL_TYPE.KINKY) return 'Kinky'
  return 'Interest Rate Model'
})

type DecodedIRMParams
  = ({ type: 'kink' } & KinkIRMParams)
    | ({ type: 'adaptive' } & AdaptiveCurveIRMParams)
    | ({ type: 'kinky' } & KinkyIRMParams)

const decodedIRMParams = computed<DecodedIRMParams | null>(() => {
  const params = vault.irmInfo?.interestRateModelInfo?.interestRateModelParams
  if (!params || params === '0x') return null

  const type = irmModelType.value

  try {
    if (type === INTEREST_RATE_MODEL_TYPE.KINK) {
      const [decoded] = decodeAbiParameters(
        [{ type: 'tuple', components: [...KINK_IRM_COMPONENTS] }],
        params as Hex,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- viem decode returns dynamic shape
      ) as any[]
      return { type: 'kink', baseRate: decoded.baseRate, slope1: decoded.slope1, slope2: decoded.slope2, kink: decoded.kink }
    }
    if (type === INTEREST_RATE_MODEL_TYPE.ADAPTIVE_CURVE) {
      const [decoded] = decodeAbiParameters(
        [{ type: 'tuple', components: [...ADAPTIVE_CURVE_IRM_COMPONENTS] }],
        params as Hex,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- viem decode returns dynamic shape
      ) as any[]
      return {
        type: 'adaptive',
        targetUtilization: decoded.targetUtilization,
        initialRateAtTarget: decoded.initialRateAtTarget,
        minRateAtTarget: decoded.minRateAtTarget,
        maxRateAtTarget: decoded.maxRateAtTarget,
        curveSteepness: decoded.curveSteepness,
        adjustmentSpeed: decoded.adjustmentSpeed,
      }
    }
    if (type === INTEREST_RATE_MODEL_TYPE.KINKY) {
      const [decoded] = decodeAbiParameters(
        [{ type: 'tuple', components: [...KINKY_IRM_COMPONENTS] }],
        params as Hex,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- viem decode returns dynamic shape
      ) as any[]
      return { type: 'kinky', baseRate: decoded.baseRate, slope: decoded.slope, shape: decoded.shape, kink: decoded.kink, cutoff: decoded.cutoff }
    }
  }
  catch (e) {
    logWarn('VaultOverviewBlockIRM/decodeParams', e)
  }
  return null
})

const irmParamsDisplay = computed<Array<{ label: string, value: string }>>(() => {
  const decoded = decodedIRMParams.value
  if (!decoded) return []

  const fmtRate = (rate: number | null) => rate !== null ? `${rate.toFixed(2)}%` : '-'

  if (decoded.type === 'kink') {
    return [
      { label: 'Base rate', value: fmtRate(chartRateAtZero.value) },
      { label: 'Rate at kink', value: fmtRate(chartRateAtKink.value) },
      { label: 'Max rate', value: fmtRate(chartRateAtMax.value) },
      { label: 'Kink', value: formatKinkPercent(decoded.kink) },
    ]
  }
  if (decoded.type === 'adaptive') {
    return [
      { label: 'Target utilization', value: formatWadPercent(decoded.targetUtilization) },
      { label: 'Min rate', value: formatWadPerSecToApy(decoded.minRateAtTarget) },
      { label: 'Max rate', value: formatWadPerSecToApy(decoded.maxRateAtTarget) },
      { label: 'Curve steepness', value: `${Number(formatUnits(decoded.curveSteepness, 18)).toFixed(2)}x` },
      { label: 'Adjustment speed', value: `${(Number(formatUnits(decoded.adjustmentSpeed, 18)) * SECONDS_PER_YEAR).toFixed(1)}x/yr` },
    ]
  }
  if (decoded.type === 'kinky') {
    return [
      { label: 'Base rate', value: fmtRate(chartRateAtZero.value) },
      { label: 'Rate at kink', value: fmtRate(chartRateAtKink.value) },
      { label: 'Max rate', value: fmtRate(chartRateAtMax.value) },
      { label: 'Kink', value: formatKinkPercent(decoded.kink) },
    ]
  }
  return []
})

const irmTooltip = computed<{ title: string, text: string } | null>(() => {
  const type = irmModelType.value
  if (type === INTEREST_RATE_MODEL_TYPE.KINK) {
    return {
      title: 'Kink IRM',
      text: 'A two-slope interest rate model. Rates increase gradually below the kink utilization point, then steeply above it to discourage over-borrowing.',
    }
  }
  if (type === INTEREST_RATE_MODEL_TYPE.ADAPTIVE_CURVE) {
    return {
      title: 'Adaptive Curve IRM',
      text: 'A dynamic interest rate model that automatically adjusts rates toward a target utilization. When utilization exceeds the target, rates increase. When below, they decrease.',
    }
  }
  if (type === INTEREST_RATE_MODEL_TYPE.KINKY) {
    return {
      title: 'Kinky IRM',
      text: 'A non-linear interest rate model with a kink point and curved rate progression. Unlike the standard Kink model, rates follow a smooth curve controlled by a shape parameter and are capped at a maximum rate.',
    }
  }
  return null
})

// Generate cash and borrows data points for chart (0-100% utilization).
// When `kinkFraction` is provided (in 0..1), injects an extra sample at the
// exact kink so the rendered curve bends there and the annotation + kink-rate
// readout land on a real data point instead of the nearest integer-percent
// neighbour. Returns the index of the kink sample, or null when none was added.
const generateChartDataPoints = (kinkFraction: number | null) => {
  const amountPoints = 100
  const TOTAL = 2 ** 32
  const TOTAL_BIG = BigInt(TOTAL)
  const borrowsData: bigint[] = [0n]

  for (let i = 1; i <= amountPoints; i += 1) {
    borrowsData.push(BigInt(Math.floor((i / amountPoints) * TOTAL)))
  }

  const cashData = [...borrowsData]
  cashData.reverse()

  let kinkIndex: number | null = null
  if (kinkFraction !== null && kinkFraction > 0 && kinkFraction < 1) {
    const kinkBorrows = BigInt(Math.floor(kinkFraction * TOTAL))
    const kinkCash = TOTAL_BIG - kinkBorrows

    // Keep the arrays sorted by borrows so the plotted line stays monotonic.
    let idx = borrowsData.findIndex(b => b >= kinkBorrows)
    if (idx < 0) idx = borrowsData.length

    if (idx < borrowsData.length && borrowsData[idx] === kinkBorrows) {
      kinkIndex = idx
    }
    else {
      borrowsData.splice(idx, 0, kinkBorrows)
      cashData.splice(idx, 0, kinkCash)
      kinkIndex = idx
    }
  }

  return { cashData, borrowsData, kinkIndex }
}

// Parse APY from bigint (27 decimals) to percentage number
const parseAPY = (apy: bigint): number => {
  return Number(formatUnits(apy, 27)) * 100
}

// Fetch interest rate model data
const fetchIRMData = async (kinkFraction: number | null) => {
  if (!eulerLensAddresses.value?.vaultLens) {
    return null
  }

  try {
    const client = rpcClient.value!

    const { cashData, borrowsData, kinkIndex } = generateChartDataPoints(kinkFraction)

    // Fetch general interest rate model info
    const irmData = await client.readContract({
      address: eulerLensAddresses.value.vaultLens as Address,
      abi: eulerVaultLensABI as Abi,
      functionName: 'getVaultInterestRateModelInfo',
      args: [vault.address, cashData, borrowsData],
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- dynamic lens contract return
    }) as Record<string, any>

    return {
      irmData,
      kinkIndex,
    }
  }
  catch (error) {
    logWarn('VaultOverviewBlockIRM/fetchIRMData', error)
    return null
  }
}

// Initialize and render chart
const renderChart = async () => {
  if (!hasValidIRM.value) return

  isLoading.value = true
  hasError.value = false

  try {
    // Derive kink utilization (0..1) from decoded params for KINK and KINKY types.
    // This drives BOTH the annotation line position and the extra sample injected
    // into the sweep so the curve bends at the exact kink.
    const decoded = decodedIRMParams.value
    const kinkFraction = (decoded && (decoded.type === 'kink' || decoded.type === 'kinky'))
      ? Number(decoded.kink) / MAX_UINT32
      : null
    const kinkUtilization = kinkFraction !== null ? kinkFraction * 100 : null

    const data = await fetchIRMData(kinkFraction)

    if (!data || !data.irmData?.interestRateInfo) {
      hasError.value = true
      isLoading.value = false
      return
    }

    const { irmData, kinkIndex } = data

    // Read chart colors from CSS variables (theme-aware)
    const colors = getChartColors()

    // Prepare chart data. With a kink sample injected, index → utilization is no
    // longer i/(N-1). Regular samples keep integer-percent labels (so the every-
    // 10% tick rule still fires). The injected sample gets a two-decimal label
    // reflecting the exact kink utilization, which deliberately doesn't match
    // the integer-tick rule — no stray tick at a non-round utilization.
    const labels: string[] = []
    const borrowAPYValues: number[] = []
    const supplyAPYValues: number[] = []

    irmData.interestRateInfo.forEach((rate: { borrowAPY: bigint, supplyAPY: bigint }, i: number) => {
      if (kinkIndex !== null && i === kinkIndex && kinkUtilization !== null) {
        labels.push(kinkUtilization.toFixed(2))
      }
      else {
        const originalIndex = kinkIndex !== null && i > kinkIndex ? i - 1 : i
        labels.push(originalIndex.toFixed(0))
      }
      borrowAPYValues.push(parseAPY(rate.borrowAPY))
      supplyAPYValues.push(parseAPY(rate.supplyAPY))
    })

    // Store key borrow APY values for the params display.
    chartRateAtZero.value = borrowAPYValues[0] ?? null
    chartRateAtMax.value = borrowAPYValues[borrowAPYValues.length - 1] ?? null
    chartRateAtKink.value = kinkIndex !== null
      ? borrowAPYValues[kinkIndex] ?? null
      : null

    // Current utilization
    const currentUtilization = getVaultUtilization(vault)

    // Set chart data
    chartData.value = {
      labels,
      datasets: [
        {
          label: 'Borrow APY',
          data: borrowAPYValues,
          borderColor: colors.lineA,
          backgroundColor: colors.fillA,
          borderWidth: 2.5,
          pointRadius: 0,
          pointHoverRadius: 6,
          pointHitRadius: 30,
          tension: 0.4,
          fill: true,
        },
        {
          label: 'Supply APY',
          data: supplyAPYValues,
          borderColor: colors.lineB,
          backgroundColor: colors.fillB,
          borderWidth: 2.5,
          pointRadius: 0,
          pointHoverRadius: 6,
          pointHitRadius: 30,
          tension: 0.4,
          fill: true,
        },
      ],
    }

    // Prepare annotations (vertical lines)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- chart.js annotation plugin config
    const annotations: any = {
      currentLine: {
        type: 'line',
        xMin: currentUtilization.toFixed(0),
        xMax: currentUtilization.toFixed(0),
        borderColor: colors.annotationLine,
        borderWidth: 1,
        borderDash: [5, 5],
        label: {
          display: true,
          content: `Current (${currentUtilization.toFixed(2)}%)`,
          position: 'end',
          backgroundColor: colors.annotationBg,
          color: colors.annotationText,
          font: {
            size: 11,
          },
          padding: 4,
        },
      },
    }

    if (kinkUtilization !== null && kinkIndex !== null) {
      const labelsAreClose = Math.abs(currentUtilization - kinkUtilization) < 20
      const currentIsLower = currentUtilization <= kinkUtilization
      const yOffset = labelsAreClose ? 24 : 0

      if (labelsAreClose && currentIsLower) {
        annotations.currentLine.label.yAdjust = yOffset
      }

      // Anchor to the injected sample's label so the line lands exactly on the
      // kink data point. Using the raw kink percent here would miss the sample
      // because the category axis positions by label match, not numeric value.
      const kinkLabel = labels[kinkIndex]

      annotations.kinkLine = {
        type: 'line',
        xMin: kinkLabel,
        xMax: kinkLabel,
        borderColor: colors.lineA,
        borderWidth: 1,
        borderDash: [5, 5],
        label: {
          display: true,
          content: `Kink (${kinkUtilization.toFixed(2)}%)`,
          position: 'end',
          yAdjust: labelsAreClose && !currentIsLower ? yOffset : 0,
          backgroundColor: colors.lineA,
          color: colors.annotationText,
          font: {
            size: 11,
          },
          padding: 4,
        },
      }
    }

    // Set chart options
    chartOptions.value = {
      responsive: true,
      maintainAspectRatio: false,
      interaction: {
        mode: 'index',
        intersect: false,
        axis: 'x',
      },
      plugins: {
        legend: {
          display: false,
        },
        tooltip: {
          enabled: true,
          mode: 'index',
          intersect: false,
          position: 'nearest',
          backgroundColor: colors.tooltip.bg,
          titleColor: colors.tooltip.text,
          bodyColor: colors.tooltip.text,
          borderColor: colors.tooltip.border,
          borderWidth: 1,
          padding: 12,
          displayColors: true,
          boxWidth: 10,
          boxHeight: 10,
          boxPadding: 4,
          callbacks: {
            title: (context) => {
              return `Utilization: ${context[0].label}%`
            },
            label: (context) => {
              const value = typeof context.parsed.y === 'number' ? context.parsed.y.toFixed(2) : 'N/A'
              return `${context.dataset.label}: ${value}%`
            },
            labelColor: (context) => {
              return {
                borderColor: context.dataset.borderColor as string,
                backgroundColor: context.dataset.borderColor as string,
                borderWidth: 0,
              }
            },
          },
        },
        annotation: {
          annotations,
        },
      },
      hover: {
        mode: 'index',
        intersect: false,
      },
      scales: {
        x: {
          title: {
            display: true,
            text: 'Utilization %',
            color: colors.text,
            font: {
              size: 12,
            },
          },
          ticks: {
            color: colors.text,
            callback: function (value, _index) {
              // Show every 10th label
              const label = this.getLabelForValue(Number(value))
              return Number(label) % 10 === 0 ? `${label}%` : ''
            },
          },
          grid: {
            color: colors.gridLine,
          },
          border: {
            color: colors.axisLine,
          },
        },
        y: {
          title: {
            display: true,
            text: 'APY %',
            color: colors.text,
            font: {
              size: 12,
            },
          },
          ticks: {
            color: colors.text,
            callback: value => `${value}%`,
          },
          grid: {
            color: colors.gridLine,
          },
          border: {
            color: colors.axisLine,
          },
        },
      },
    }
  }
  catch (error) {
    logWarn('VaultOverviewBlockIRM/renderChart', error)
    hasError.value = true
  }
  finally {
    isLoading.value = false
  }
}

onMounted(async () => {
  if (hasValidIRM.value) {
    await nextTick()
    await renderChart()
  }
})

// Re-render chart when hasValidIRM transitions false → true after mount.
// This happens when the vault registry loads collateral vaults asynchronously
// after the component has already mounted with an empty registry.
watch(hasValidIRM, async (newVal) => {
  if (newVal && !chartData.value) {
    await nextTick()
    await renderChart()
  }
})

// Re-render chart when theme changes (isDark comes from useTheme via useThemeColors,
// so it fires AFTER app.vue's watcher updates data-theme on the DOM)
watch(isDark, async () => {
  if (chartData.value && hasValidIRM.value) {
    await nextTick()
    await renderChart()
  }
})
</script>

<template>
  <div
    v-if="hasValidIRM"
    class="bg-surface-secondary rounded-xl flex flex-col gap-16 p-24 shadow-card"
  >
    <div class="flex justify-between items-center flex-wrap gap-12">
      <div class="flex items-center gap-8">
        <p class="text-h3 text-content-primary">
          Interest rate model
        </p>
        <div class="irm-type-chip inline-flex items-center py-2 px-8 rounded-8 text-[13px] font-medium">
          {{ irmTypeLabel }}
        </div>
        <UiFootnote
          v-if="irmTooltip"
          :title="irmTooltip.title"
          :text="irmTooltip.text"
          class="[--ui-footnote-icon-color:var(--text-muted)] hover:[--ui-footnote-icon-color:var(--text-secondary)]"
        />
      </div>
    </div>

    <div class="relative w-full min-h-400">
      <div
        v-if="isLoading"
        class="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 text-content-tertiary text-center pointer-events-none z-10"
      >
        Loading chart...
      </div>
      <div
        v-else-if="hasError"
        class="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 text-red-500 text-center pointer-events-none z-10"
      >
        Failed to load interest rate data
      </div>
      <div
        v-if="chartData && chartOptions"
        class="w-full h-[400px]"
      >
        <Line
          :data="chartData"
          :options="chartOptions"
        />
      </div>
    </div>

    <div
      v-if="irmParamsDisplay.length"
      class="grid grid-cols-2 sm:grid-cols-3 gap-16"
    >
      <VaultOverviewLabelValue
        v-for="param in irmParamsDisplay"
        :key="param.label"
        :label="param.label"
        :value="param.value"
      />
    </div>
  </div>
</template>

<style scoped lang="scss">
.irm-type-chip {
  background-color: rgba(var(--accent-rgb), 0.15);
  color: var(--accent-600);

  [data-theme="dark"] & {
    background-color: rgba(var(--accent-rgb), 0.2);
    color: var(--accent-500);
  }
}
</style>
