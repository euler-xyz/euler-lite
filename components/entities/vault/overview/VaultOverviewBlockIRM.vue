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
import { formatUnits, type Address, type Abi } from 'viem'
import { logWarn } from '~/utils/errorHandling'
import { getPublicClient } from '~/utils/public-client'
import { INTEREST_RATE_MODEL_TYPE } from '~/entities/constants'
import { BPS_BASE } from '~/entities/tuning-constants'
import type { Vault } from '~/entities/vault'
import { getVaultUtilization } from '~/entities/vault'
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

// Theme detection
const theme = useLocalStorage('theme', 'light')
const isDark = computed(() => theme.value === 'dark')

// Theme-aware colors
const chartColors = computed(() => isDark.value
  ? {
      text: '#a3a3a3',
      textMuted: '#737373',
      gridLine: 'rgba(255, 255, 255, 0.06)',
      axisLine: 'rgba(255, 255, 255, 0.1)',
      tooltip: {
        bg: 'rgba(26, 26, 26, 0.95)',
        border: '#404040',
        text: '#fafafa',
        textMuted: '#a3a3a3',
      },
      currentLine: '#a3a3a3',
    }
  : {
      text: '#737373',
      textMuted: '#525252',
      gridLine: '#f5f5f5',
      axisLine: '#e5e5e5',
      tooltip: {
        bg: 'rgba(255, 255, 255, 0.95)',
        border: '#e5e5e5',
        text: '#262626',
        textMuted: '#525252',
      },
      currentLine: '#262626',
    })

const { EVM_PROVIDER_URL } = useEulerConfig()
const { eulerLensAddresses } = useEulerAddresses()

// Check if IRM is valid (not zero address)
const hasValidIRM = computed(() => {
  return vault.interestRateModelAddress
    && vault.interestRateModelAddress !== '0x0000000000000000000000000000000000000000'
})

const irmTypeLabel = computed(() => {
  const modelType = Number(vault.irmInfo?.interestRateModelInfo?.interestRateModelType)
  if (modelType === INTEREST_RATE_MODEL_TYPE.KINK) {
    return 'Kink'
  }
  else if (modelType === INTEREST_RATE_MODEL_TYPE.ADAPTIVE_CURVE) {
    return 'Adaptive'
  }
  return 'Interest Rate Model'
})

// Generate cash and borrows data points for chart (0-100% utilization)
const generateChartDataPoints = () => {
  const amountPoints = 100
  const borrowsData: bigint[] = [BigInt(0)]

  for (let i = 1; i <= amountPoints; i += 1) {
    const borrow: bigint = BigInt(Math.floor((i / amountPoints) * 2 ** 32))
    borrowsData.push(borrow)
  }

  const cashData = [...borrowsData]
  cashData.reverse()

  return { cashData, borrowsData }
}

// Parse APY from bigint (27 decimals) to percentage number
const parseAPY = (apy: bigint): number => {
  return Number(formatUnits(apy, 27)) * 100
}

// Fetch interest rate model data
const fetchIRMData = async () => {
  if (!eulerLensAddresses.value?.vaultLens) {
    return null
  }

  try {
    const client = getPublicClient(EVM_PROVIDER_URL)

    const { cashData, borrowsData } = generateChartDataPoints()

    // Fetch general interest rate model info
    const irmData = await client.readContract({
      address: eulerLensAddresses.value.vaultLens as Address,
      abi: eulerVaultLensABI as Abi,
      functionName: 'getVaultInterestRateModelInfo',
      args: [vault.address, cashData, borrowsData],
    }) as Record<string, any>

    let kinkData = null
    const modelType = Number(irmData.interestRateModelInfo?.interestRateModelType)

    // Fetch kink-specific data if applicable
    if (modelType === INTEREST_RATE_MODEL_TYPE.KINK) {
      try {
        kinkData = await client.readContract({
          address: eulerLensAddresses.value.vaultLens as Address,
          abi: eulerVaultLensABI as Abi,
          functionName: 'getVaultKinkInterestRateModelInfo',
          args: [vault.address],
        }) as Record<string, any>
      }
      catch (e) {
        logWarn('VaultOverviewBlockIRM/fetchKinkIRM', e)
      }
    }

    return {
      irmData,
      kinkData,
    }
  }
  catch (error) {
    console.error('Failed to fetch IRM data:', error)
    return null
  }
}

// Initialize and render chart
const renderChart = async () => {
  if (!hasValidIRM.value) return

  isLoading.value = true
  hasError.value = false

  try {
    const data = await fetchIRMData()

    if (!data || !data.irmData?.interestRateInfo) {
      hasError.value = true
      isLoading.value = false
      return
    }

    const { irmData, kinkData } = data

    // Prepare chart data
    const labels: string[] = []
    const borrowAPYValues: number[] = []
    const supplyAPYValues: number[] = []

    irmData.interestRateInfo.forEach((rate: { borrowAPY: bigint, supplyAPY: bigint }, i: number) => {
      const utilization = ((i / (irmData.interestRateInfo.length - 1)) * 100).toFixed(0)
      labels.push(utilization)
      borrowAPYValues.push(parseAPY(rate.borrowAPY))
      supplyAPYValues.push(parseAPY(rate.supplyAPY))
    })

    // Current utilization
    const currentUtilization = getVaultUtilization(vault)

    // Kink utilization if available
    let kinkUtilization: number | null = null
    if (kinkData?.interestRateInfo && kinkData.interestRateInfo.length > 1) {
      const kinkInfo = kinkData.interestRateInfo[1]
      const kinkCash = kinkData.interestRateInfo[0]?.cash || 0n
      const kinkBorrows = kinkInfo?.borrows || 0n
      if (kinkCash > 0n) {
        kinkUtilization = Number((kinkBorrows * BPS_BASE) / kinkCash) / 100
      }
    }

    // Set chart data
    chartData.value = {
      labels,
      datasets: [
        {
          label: 'Borrow APY',
          data: borrowAPYValues,
          borderColor: '#059669',
          backgroundColor: 'rgba(5, 150, 105, 0.15)',
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
          borderColor: '#22c09b',
          backgroundColor: 'rgba(34, 192, 155, 0.15)',
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
    const annotations: any = {
      currentLine: {
        type: 'line',
        xMin: currentUtilization.toFixed(0),
        xMax: currentUtilization.toFixed(0),
        borderColor: chartColors.value.currentLine,
        borderWidth: 1,
        borderDash: [5, 5],
        label: {
          display: true,
          content: `Current (${currentUtilization.toFixed(2)}%)`,
          position: 'end',
          backgroundColor: isDark.value ? 'rgba(64, 64, 64, 0.85)' : 'rgba(82, 82, 82, 0.85)',
          color: '#FFFFFF',
          font: {
            size: 11,
          },
          padding: 4,
        },
      },
    }

    if (kinkUtilization !== null) {
      annotations.kinkLine = {
        type: 'line',
        xMin: kinkUtilization.toFixed(0),
        xMax: kinkUtilization.toFixed(0),
        borderColor: '#059669',
        borderWidth: 1,
        borderDash: [5, 5],
        label: {
          display: true,
          content: `Kink (${kinkUtilization.toFixed(2)}%)`,
          position: 'end',
          backgroundColor: 'rgba(5, 150, 105, 0.8)',
          color: '#FFFFFF',
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
          backgroundColor: chartColors.value.tooltip.bg,
          titleColor: chartColors.value.tooltip.text,
          bodyColor: chartColors.value.tooltip.text,
          borderColor: chartColors.value.tooltip.border,
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
            color: chartColors.value.text,
            font: {
              size: 12,
            },
          },
          ticks: {
            color: chartColors.value.text,
            callback: function (value, _index) {
              // Show every 10th label
              const label = this.getLabelForValue(Number(value))
              return Number(label) % 10 === 0 ? `${label}%` : ''
            },
          },
          grid: {
            color: chartColors.value.gridLine,
          },
          border: {
            color: chartColors.value.axisLine,
          },
        },
        y: {
          title: {
            display: true,
            text: 'APY %',
            color: chartColors.value.text,
            font: {
              size: 12,
            },
          },
          ticks: {
            color: chartColors.value.text,
            callback: value => `${value}%`,
          },
          grid: {
            color: chartColors.value.gridLine,
          },
          border: {
            color: chartColors.value.axisLine,
          },
        },
      },
    }
  }
  catch (error) {
    console.error('Failed to render chart:', error)
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

// Re-render chart when theme changes
watch(theme, async () => {
  if (chartData.value && hasValidIRM.value) {
    await nextTick()
    await renderChart()
  }
})
</script>

<template>
  <div
    v-if="hasValidIRM"
    class="flex flex-col gap-16 p-24 border-b border-line-default last:border-b-0"
  >
    <div class="flex justify-between items-center flex-wrap gap-12">
      <div class="flex items-center gap-8">
        <p class="text-h3 text-content-primary">
          Interest rate model
        </p>
        <div class="inline-flex items-center py-0 px-4 rounded-4 bg-accent-300/30 text-accent-700 text-[12px] font-medium capitalize">
          {{ irmTypeLabel }}
        </div>
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
  </div>
</template>
