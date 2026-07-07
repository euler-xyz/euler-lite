<script setup lang="ts">
import type { EVault } from '@eulerxyz/euler-v2-sdk'
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
import { Line } from 'vue-chartjs'
import { logWarn } from '~/utils/errorHandling'
import { compactNumber, formatCompactUsdValue } from '~/utils/string-utils'
import { isVaultBorrowable } from '~/utils/vault/classification'
import {
  buildVaultTotalsHistoryPath,
  getVaultHistoryTimeRange,
  parseVaultTotalsHistory,
  VAULT_HISTORY_FETCH_TIMEFRAME,
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
)

type MetricOption = {
  value: VaultHistoryMetric
  label: string
}
type DenominationOption = 'asset' | 'usd'
type FetchErrorLike = {
  status?: number
  statusCode?: number
  response?: {
    status?: number
    headers?: Pick<Headers, 'get'>
  }
}

const { vault, defaultOpen = false } = defineProps<{
  vault: EVault
  defaultOpen?: boolean
}>()

const { chainId } = useEulerAddresses()
const { enableV3Backend } = useEnvConfig()
const { getChartColors, isDark } = useThemeColors()

const selectedMetric = ref<VaultHistoryMetric>('totalSupply')
const selectedDenomination = ref<DenominationOption>('usd')
const selectedTimeframe = ref<VaultHistoryTimeframe>('30d')
const fetchedHistory = shallowRef<VaultHistoryPoint[]>([])
const fetchedHistoryEnd = ref<number | null>(null)
const isLoading = ref(false)
const hasError = ref(false)
let activeRequestId = 0
let activeHistoryContext: { address: string, chainId: string } | null = null

const RETRYABLE_HISTORY_STATUSES = new Set([429, 500, 502, 503, 504])
const DEFAULT_HISTORY_RETRY_AFTER_MS = 1_000
const MAX_HISTORY_RETRY_AFTER_MS = 10_000

const isBorrowableEVault = computed(() =>
  isVaultBorrowable(vault),
)
const canLoadHistory = computed(() =>
  enableV3Backend && Boolean(chainId.value),
)
const decimals = computed(() => Number(vault.asset.decimals ?? 18))
const selectedTimeframeOption = computed(() =>
  VAULT_HISTORY_TIMEFRAMES.find(timeframe => timeframe.value === selectedTimeframe.value) ?? VAULT_HISTORY_TIMEFRAMES[1],
)
const history = computed(() => {
  const to = fetchedHistoryEnd.value
  if (to === null) return fetchedHistory.value

  const from = to - selectedTimeframeOption.value.days * 24 * 60 * 60
  return fetchedHistory.value.filter((point) => {
    const timestamp = Math.floor(Date.parse(point.timestamp) / 1_000)
    return Number.isFinite(timestamp)
      && timestamp >= from
      && timestamp <= to
  })
})
const hasBorrowHistory = computed(() =>
  history.value.some(point =>
    (point.totalBorrows ?? 0) > 0
    || (point.utilization ?? 0) > 0
    || (point.borrowApy ?? 0) > 0,
  ),
)
const shouldShowBorrowMetrics = computed(() =>
  isBorrowableEVault.value || hasBorrowHistory.value,
)

const metricOptions = computed<MetricOption[]>(() => {
  if (shouldShowBorrowMetrics.value) {
    return [
      { value: 'totalSupply', label: 'Total supply' },
      { value: 'totalBorrows', label: 'Total borrowed' },
      { value: 'cash', label: 'Available Liquidity' },
      { value: 'utilization', label: 'Utilization' },
      { value: 'apy', label: 'APY' },
    ]
  }

  return [
    { value: 'totalSupply', label: 'Total supply' },
    { value: 'cash', label: 'Available Liquidity' },
  ]
})

const selectedMetricLabel = computed(() =>
  metricOptions.value.find(option => option.value === selectedMetric.value)?.label ?? 'Metric',
)

const isPercentMetric = (metric: VaultHistoryMetric) =>
  metric === 'apy' || metric === 'utilization'

const pointUsdValue = (point: VaultHistoryPoint, metric: VaultHistoryMetric): number | null => {
  switch (metric) {
    case 'totalSupply':
      return point.totalAssetsUsd
    case 'totalBorrows':
      return point.totalBorrowsUsd
    case 'cash':
      return point.cashUsd
    default:
      return null
  }
}

const hasSelectedMetricUsdData = computed(() =>
  !isPercentMetric(selectedMetric.value)
  && history.value.some(point => pointUsdValue(point, selectedMetric.value) !== null),
)
// While the toggle is hidden (percent metrics, missing USD data) the chart
// falls back to asset values via the canToggleDenomination guards, but the
// selection itself is kept so returning to a USD-capable metric restores it.
const canToggleDenomination = computed(() =>
  !isPercentMetric(selectedMetric.value) && hasSelectedMetricUsdData.value,
)
const shouldShowHistoryControls = computed(() =>
  metricOptions.value.length > 1,
)

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

  if (!canLoadHistory.value || !chainId.value) {
    fetchedHistory.value = []
    fetchedHistoryEnd.value = null
    activeHistoryContext = null
    isLoading.value = false
    hasError.value = false
    return
  }

  const requestContext = {
    address: vault.address.toLowerCase(),
    chainId: String(chainId.value),
  }
  const canPreserveHistory = activeHistoryContext !== null
    && activeHistoryContext.address === requestContext.address
    && activeHistoryContext.chainId === requestContext.chainId
    && fetchedHistory.value.length > 0

  if (!canPreserveHistory) {
    fetchedHistory.value = []
    fetchedHistoryEnd.value = null
  }

  isLoading.value = true
  hasError.value = false

  try {
    const requestTime = Date.now()
    const { to } = getVaultHistoryTimeRange(VAULT_HISTORY_FETCH_TIMEFRAME, requestTime)
    const response = await fetchVaultTotalsHistoryWithCooldownRetry(
      buildVaultTotalsHistoryPath(chainId.value, vault.address, VAULT_HISTORY_FETCH_TIMEFRAME, requestTime),
      () => requestId === activeRequestId,
    )
    if (requestId !== activeRequestId) return

    fetchedHistory.value = parseVaultTotalsHistory(response, decimals.value)
    fetchedHistoryEnd.value = to
    activeHistoryContext = requestContext
  }
  catch (error) {
    if (requestId !== activeRequestId) return

    if (!canPreserveHistory) {
      fetchedHistory.value = []
      fetchedHistoryEnd.value = null
      activeHistoryContext = null
    }
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
  [chainId, canLoadHistory, () => vault.address],
  () => {
    void loadHistory()
  },
  { immediate: true },
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

const pointChartValue = (point: VaultHistoryPoint, metric: VaultHistoryMetric): number | null =>
  selectedDenomination.value === 'usd' && canToggleDenomination.value
    ? pointUsdValue(point, metric)
    : pointValue(point, metric)

const visiblePoints = computed(() =>
  history.value.filter(point => pointChartValue(point, selectedMetric.value) !== null),
)
const hasChartData = computed(() => visiblePoints.value.length > 1)

const chartData = computed<ChartData<'line', number[], string>>(() => {
  void isDark.value
  const colors = getChartColors()
  const labels = visiblePoints.value.map(point => formatDate(point.timestamp))
  const primaryValues = visiblePoints.value.map(point => pointChartValue(point, selectedMetric.value) ?? 0)

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

  if (selectedMetric.value === 'apy' && shouldShowBorrowMetrics.value) {
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

const formatValue = (value: number, metric: VaultHistoryMetric = selectedMetric.value) => {
  if (isPercentMetric(metric)) return `${compactNumber(value, 2, 0)}%`
  if (selectedDenomination.value === 'usd' && canToggleDenomination.value) return formatCompactUsdValue(value)
  return `${compactNumber(value, 2, 0)} ${vault.asset.symbol}`
}

const chartOptions = computed<ChartOptions<'line'>>(() => {
  void isDark.value
  const colors = getChartColors()

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
          label: (context) => {
            const metric = selectedMetric.value === 'apy' && context.dataset.label === 'Borrow APY'
              ? 'apy'
              : selectedMetric.value
            return `${context.dataset.label}: ${formatValue(Number(context.parsed.y), metric)}`
          },
        },
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
    v-if="canLoadHistory"
    title="Performance"
    :default-open="defaultOpen"
    content-class="flex flex-col gap-16"
  >
    <template #actions="{ isOpen }">
      <div
        v-if="isOpen && shouldShowHistoryControls"
        class="flex flex-wrap items-center justify-end gap-8 mobile:hidden"
      >
        <div
          class="relative inline-flex h-32 rounded-8 border border-line-subtle bg-surface transition-colors hover:border-line focus-within:border-accent-500"
        >
          <select
            v-model="selectedMetric"
            class="absolute inset-0 h-full w-full cursor-pointer appearance-none opacity-0"
            aria-label="Performance metric"
          >
            <option
              v-for="option in metricOptions"
              :key="option.value"
              :value="option.value"
            >
              {{ option.label }}
            </option>
          </select>
          <div class="pointer-events-none flex h-full items-center gap-8 px-10 text-p3 text-content-primary">
            <span class="whitespace-nowrap">{{ selectedMetricLabel }}</span>
            <UiIcon
              name="arrow-down"
              class="h-16 w-16 shrink-0 text-content-secondary"
            />
          </div>
        </div>
      </div>
    </template>

    <div
      v-if="shouldShowHistoryControls"
      class="hidden flex-wrap items-center gap-8 mobile:flex"
    >
      <div
        class="relative inline-flex h-32 rounded-8 border border-line-subtle bg-surface transition-colors hover:border-line focus-within:border-accent-500"
      >
        <select
          v-model="selectedMetric"
          class="absolute inset-0 h-full w-full cursor-pointer appearance-none opacity-0"
          aria-label="Performance metric"
        >
          <option
            v-for="option in metricOptions"
            :key="option.value"
            :value="option.value"
          >
            {{ option.label }}
          </option>
        </select>
        <div class="pointer-events-none flex h-full items-center gap-8 px-10 text-p3 text-content-primary">
          <span class="whitespace-nowrap">{{ selectedMetricLabel }}</span>
          <UiIcon
            name="arrow-down"
            class="h-16 w-16 shrink-0 text-content-secondary"
          />
        </div>
      </div>
    </div>

    <div
      v-if="isLoading && !hasChartData"
      class="h-[260px] rounded-12 bg-surface animate-pulse"
    />

    <div
      v-else-if="hasError"
      class="rounded-12 border border-line-subtle bg-surface p-16 text-p3 text-content-secondary"
    >
      Performance is unavailable for this vault right now.
    </div>

    <div
      v-else-if="!hasChartData"
      class="rounded-12 border border-line-subtle bg-surface p-16 text-p3 text-content-secondary"
    >
      No performance data is available for the selected range.
    </div>

    <template v-else>
      <div class="relative h-[260px] min-w-0">
        <div
          class="h-full transition-opacity duration-150"
          :class="{ 'opacity-60': isLoading }"
        >
          <Line
            :data="chartData"
            :options="chartOptions"
          />
        </div>
        <div
          v-if="isLoading"
          class="pointer-events-none absolute inset-0 rounded-12 bg-surface/20"
        />
      </div>

      <div class="flex flex-wrap items-center gap-8">
        <button
          v-for="timeframe in VAULT_HISTORY_TIMEFRAMES"
          :key="timeframe.value"
          type="button"
          class="h-32 min-w-48 rounded-8 px-10 text-p3 transition-colors"
          :class="selectedTimeframe === timeframe.value ? 'bg-accent-600 text-black hover:bg-accent-700' : 'bg-surface text-content-secondary hover:text-content-primary'"
          @click="selectedTimeframe = timeframe.value"
        >
          {{ timeframe.label }}
        </button>

        <div
          v-if="canToggleDenomination"
          class="h-20 w-[1px] shrink-0 bg-line-subtle"
          aria-hidden="true"
        />

        <div
          v-if="canToggleDenomination"
          class="contents"
          role="group"
          aria-label="Chart denomination"
        >
          <button
            type="button"
            class="h-32 min-w-48 rounded-8 px-10 text-p3 transition-colors"
            :class="selectedDenomination === 'usd' ? 'bg-accent-600 text-black hover:bg-accent-700' : 'bg-surface text-content-secondary hover:text-content-primary'"
            :aria-pressed="selectedDenomination === 'usd'"
            @click="selectedDenomination = 'usd'"
          >
            USD
          </button>
          <button
            type="button"
            class="h-32 min-w-48 rounded-8 px-10 text-p3 transition-colors"
            :class="selectedDenomination === 'asset' ? 'bg-accent-600 text-black hover:bg-accent-700' : 'bg-surface text-content-secondary hover:text-content-primary'"
            :aria-pressed="selectedDenomination === 'asset'"
            @click="selectedDenomination = 'asset'"
          >
            {{ vault.asset.symbol }}
          </button>
        </div>
      </div>
    </template>
  </VaultOverviewAccordionSection>
</template>
