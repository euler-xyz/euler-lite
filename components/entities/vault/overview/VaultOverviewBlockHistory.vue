<script setup lang="ts">
import {
  isEVault,
  isSecuritizeCollateralVault,
  type EVault,
  type EulerEarn,
  type SecuritizeCollateralVault,
} from '@eulerxyz/euler-v2-sdk'
import annotationPlugin from 'chartjs-plugin-annotation'
import {
  CategoryScale,
  Chart as ChartJS,
  Filler,
  Legend,
  LinearScale,
  LineElement,
  PointElement,
  Tooltip,
  type ChartData,
  type ChartOptions,
} from 'chart.js'
import { formatUnits } from 'viem'
import { Line } from 'vue-chartjs'
import { logWarn } from '~/utils/errorHandling'
import { compactNumber } from '~/utils/string-utils'
import { isVaultBorrowable } from '~/utils/vault/classification'
import {
  buildVaultTotalsHistoryPath,
  hasFiniteCap,
  parseVaultTotalsHistory,
  VAULT_HISTORY_TIMEFRAMES,
  type VaultHistoryMetric,
  type VaultHistoryPoint,
  type VaultHistoryTimeframe,
  type VaultTotalsHistoryResponse,
} from '~/utils/vault-history'

ChartJS.register(
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  Tooltip,
  Legend,
  Filler,
  annotationPlugin,
)

type HistoryVault = EVault | SecuritizeCollateralVault | EulerEarn
type MetricOption = {
  value: VaultHistoryMetric
  label: string
}
type FetchErrorLike = {
  status?: number
  statusCode?: number
  response?: {
    status?: number
    headers?: Pick<Headers, 'get'>
  }
}

const { vault, defaultOpen = false } = defineProps<{
  vault: HistoryVault
  defaultOpen?: boolean
}>()

const { chainId } = useEulerAddresses()
const { enableV3Backend } = useEnvConfig()
const { getChartColors, isDark } = useThemeColors()

const selectedMetric = ref<VaultHistoryMetric>('totalSupply')
const selectedTimeframe = ref<VaultHistoryTimeframe>('30d')
const history = shallowRef<VaultHistoryPoint[]>([])
const isLoading = ref(false)
const hasError = ref(false)
let activeRequestId = 0

const RETRYABLE_HISTORY_STATUSES = new Set([429, 500, 502, 503, 504])
const DEFAULT_HISTORY_RETRY_AFTER_MS = 1_000
const MAX_HISTORY_RETRY_AFTER_MS = 10_000

const isBorrowableEVault = computed(() =>
  isEVault(vault) && isVaultBorrowable(vault),
)
const canLoadHistory = computed(() =>
  enableV3Backend && isEVault(vault) && Boolean(chainId.value),
)
const decimals = computed(() => Number(vault.asset.decimals ?? 18))

const metricOptions = computed<MetricOption[]>(() => {
  if (isEVault(vault)) {
    if (isBorrowableEVault.value) {
      return [
        { value: 'apy', label: 'APY' },
        { value: 'totalSupply', label: 'Total supply' },
        { value: 'totalBorrows', label: 'Total borrowed' },
        { value: 'utilization', label: 'Utilization' },
        { value: 'cash', label: 'Cash' },
      ]
    }

    return [
      { value: 'totalSupply', label: 'Total supply' },
      { value: 'cash', label: 'Cash' },
    ]
  }

  if (isSecuritizeCollateralVault(vault) || 'strategies' in vault) {
    return [
      { value: 'apy', label: 'APY' },
      { value: 'totalSupply', label: 'Total supply' },
      { value: 'cash', label: 'Cash' },
    ]
  }

  return []
})

watch(
  metricOptions,
  (options) => {
    if (!options.some(option => option.value === selectedMetric.value)) {
      selectedMetric.value = options[0]?.value ?? 'totalSupply'
    }
  },
  { immediate: true },
)

const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

const readRetryAfterMs = (error: unknown): number | null => {
  const fetchError = error as FetchErrorLike
  const status = fetchError.response?.status ?? fetchError.statusCode ?? fetchError.status
  if (typeof status !== 'number' || !RETRYABLE_HISTORY_STATUSES.has(status)) return null

  const retryAfter = fetchError.response?.headers?.get('retry-after')
  if (!retryAfter) return DEFAULT_HISTORY_RETRY_AFTER_MS

  const seconds = Number(retryAfter)
  if (Number.isFinite(seconds) && seconds > 0) {
    return Math.min(seconds * 1_000, MAX_HISTORY_RETRY_AFTER_MS)
  }

  const retryAt = Date.parse(retryAfter)
  if (Number.isFinite(retryAt)) {
    return Math.min(Math.max(retryAt - Date.now(), 0), MAX_HISTORY_RETRY_AFTER_MS)
  }

  return DEFAULT_HISTORY_RETRY_AFTER_MS
}

const fetchVaultTotalsHistoryWithCooldownRetry = async (
  path: string,
  isCurrent: () => boolean,
): Promise<VaultTotalsHistoryResponse> => {
  let attempt = 0

  while (true) {
    try {
      return await $fetch<VaultTotalsHistoryResponse>(path, { retry: 0 })
    }
    catch (error) {
      const retryAfterMs = readRetryAfterMs(error)
      if (attempt > 0 || retryAfterMs === null || !isCurrent()) throw error

      attempt += 1
      await wait(retryAfterMs)
      if (!isCurrent()) throw error
    }
  }
}

const loadHistory = async () => {
  const requestId = ++activeRequestId
  history.value = []

  if (!canLoadHistory.value || !chainId.value || !isEVault(vault)) {
    isLoading.value = false
    hasError.value = false
    return
  }

  isLoading.value = true
  hasError.value = false

  try {
    const response = await fetchVaultTotalsHistoryWithCooldownRetry(
      buildVaultTotalsHistoryPath(chainId.value, vault.address, selectedTimeframe.value),
      () => requestId === activeRequestId,
    )
    if (requestId !== activeRequestId) return

    history.value = parseVaultTotalsHistory(response, decimals.value)
  }
  catch (error) {
    if (requestId !== activeRequestId) return

    history.value = []
    hasError.value = true
    logWarn('VaultOverviewBlockHistory/loadHistory', error)
  }
  finally {
    if (requestId === activeRequestId) {
      isLoading.value = false
    }
  }
}

watch(
  [chainId, selectedTimeframe, canLoadHistory],
  () => {
    void loadHistory()
  },
  { immediate: true },
)

const supplyCap = computed(() => {
  if (isEVault(vault)) return vault.caps.supplyCap
  if (isSecuritizeCollateralVault(vault)) return vault.supplyCap
  return null
})
const borrowCap = computed(() => isEVault(vault) ? vault.caps.borrowCap : null)
const capValue = computed(() => {
  const cap = selectedMetric.value === 'totalSupply'
    ? supplyCap.value
    : selectedMetric.value === 'totalBorrows'
      ? borrowCap.value
      : null
  if (!hasFiniteCap(cap)) return null

  const parsed = Number(formatUnits(cap, decimals.value))
  return Number.isFinite(parsed) ? parsed : null
})
const capLabel = computed(() =>
  selectedMetric.value === 'totalSupply'
    ? 'Supply cap'
    : selectedMetric.value === 'totalBorrows'
      ? 'Borrow cap'
      : '',
)

const formatDate = (timestamp: string) =>
  new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' }).format(new Date(timestamp))

const pointValue = (point: VaultHistoryPoint, metric: VaultHistoryMetric): number | null => {
  switch (metric) {
    case 'totalSupply':
      return point.totalAssets
    case 'totalBorrows':
      return point.totalBorrows
    case 'cash':
      return point.cash
    case 'utilization':
      return point.utilization === null ? null : point.utilization * 100
    case 'apy':
      return point.supplyApy
  }
}

const visiblePoints = computed(() =>
  history.value.filter(point => pointValue(point, selectedMetric.value) !== null),
)
const hasChartData = computed(() => visiblePoints.value.length > 1)

const chartData = computed<ChartData<'line', number[], string>>(() => {
  void isDark.value
  const colors = getChartColors()
  const labels = visiblePoints.value.map(point => formatDate(point.timestamp))
  const primaryValues = visiblePoints.value.map(point => pointValue(point, selectedMetric.value) ?? 0)

  const datasets: ChartData<'line', number[], string>['datasets'] = [
    {
      label: selectedMetric.value === 'apy' ? 'Supply APY' : metricOptions.value.find(option => option.value === selectedMetric.value)?.label ?? 'Value',
      data: primaryValues,
      borderColor: colors.lineA || '#62ad4f',
      backgroundColor: colors.fillA || 'rgba(98, 173, 79, 0.15)',
      borderWidth: 2,
      pointRadius: 0,
      pointHoverRadius: 4,
      tension: 0.35,
      fill: selectedMetric.value !== 'apy',
    },
  ]

  if (selectedMetric.value === 'apy' && isBorrowableEVault.value) {
    datasets.push({
      label: 'Borrow APY',
      data: visiblePoints.value.map(point => point.borrowApy ?? 0),
      borderColor: colors.lineB || '#1c997c',
      backgroundColor: colors.fillB || 'rgba(28, 153, 124, 0.15)',
      borderWidth: 2,
      pointRadius: 0,
      pointHoverRadius: 4,
      tension: 0.35,
      fill: false,
    })
  }

  return { labels, datasets }
})

const formatValue = (value: number) =>
  selectedMetric.value === 'apy' || selectedMetric.value === 'utilization'
    ? `${compactNumber(value, 2, 0)}%`
    : `${compactNumber(value, 2, 0)} ${vault.asset.symbol}`

const chartOptions = computed<ChartOptions<'line'>>(() => {
  void isDark.value
  const colors = getChartColors()
  const annotations = capValue.value === null
    ? {}
    : {
        capLine: {
          type: 'line',
          yMin: capValue.value,
          yMax: capValue.value,
          borderColor: colors.annotationLine || '#737373',
          borderDash: [6, 6],
          borderWidth: 1,
          label: {
            display: true,
            content: capLabel.value,
            backgroundColor: colors.annotationBg || 'rgba(82, 82, 82, 0.85)',
            color: colors.annotationText || '#ffffff',
            position: 'end',
          },
        },
      }

  return {
    responsive: true,
    maintainAspectRatio: false,
    interaction: {
      mode: 'index',
      intersect: false,
    },
    plugins: {
      legend: {
        display: selectedMetric.value === 'apy',
        labels: {
          color: colors.textMuted,
          boxWidth: 10,
          boxHeight: 10,
          usePointStyle: true,
        },
      },
      tooltip: {
        backgroundColor: colors.tooltip.bg,
        borderColor: colors.tooltip.border,
        borderWidth: 1,
        titleColor: colors.tooltip.text,
        bodyColor: colors.tooltip.textMuted,
        displayColors: true,
        callbacks: {
          label: context => `${context.dataset.label}: ${formatValue(Number(context.parsed.y))}`,
        },
      },
      annotation: {
        annotations,
      },
    },
    scales: {
      x: {
        grid: {
          display: false,
        },
        ticks: {
          color: colors.textMuted,
          maxRotation: 0,
          autoSkip: true,
          maxTicksLimit: 6,
        },
        border: {
          color: colors.axisLine,
        },
      },
      y: {
        beginAtZero: selectedMetric.value !== 'apy',
        grid: {
          color: colors.gridLine,
        },
        ticks: {
          color: colors.textMuted,
          callback: value => formatValue(Number(value)),
        },
        border: {
          color: colors.axisLine,
        },
      },
    },
  } as ChartOptions<'line'>
})
</script>

<template>
  <VaultOverviewAccordionSection
    title="History"
    :default-open="defaultOpen"
    content-class="flex flex-col gap-16"
  >
    <template #actions>
      <select
        v-if="metricOptions.length > 1"
        v-model="selectedMetric"
        class="h-32 max-w-[180px] rounded-8 border border-line-subtle bg-surface px-10 text-p3 text-content-primary outline-none transition-colors hover:border-line focus:border-accent-500"
        aria-label="History metric"
      >
        <option
          v-for="option in metricOptions"
          :key="option.value"
          :value="option.value"
        >
          {{ option.label }}
        </option>
      </select>
    </template>

    <div
      v-if="isLoading"
      class="h-[260px] rounded-12 bg-surface animate-pulse"
    />

    <div
      v-else-if="!canLoadHistory || hasError"
      class="rounded-12 border border-line-subtle bg-surface p-16 text-p3 text-content-secondary"
    >
      History is unavailable for this vault right now.
    </div>

    <div
      v-else-if="!hasChartData"
      class="rounded-12 border border-line-subtle bg-surface p-16 text-p3 text-content-secondary"
    >
      No history is available for the selected range.
    </div>

    <template v-else>
      <div class="h-[260px] min-w-0">
        <Line
          :data="chartData"
          :options="chartOptions"
        />
      </div>

      <div class="flex flex-wrap items-center gap-8">
        <button
          v-for="timeframe in VAULT_HISTORY_TIMEFRAMES"
          :key="timeframe.value"
          type="button"
          class="h-32 min-w-48 rounded-8 px-10 text-p3 transition-colors"
          :class="selectedTimeframe === timeframe.value ? 'bg-accent-600 text-white' : 'bg-surface text-content-secondary hover:text-content-primary'"
          @click="selectedTimeframe = timeframe.value"
        >
          {{ timeframe.label }}
        </button>
      </div>
    </template>
  </VaultOverviewAccordionSection>
</template>
