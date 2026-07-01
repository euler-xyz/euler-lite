<script setup lang="ts">
import type { EVault, SecuritizeCollateralVault } from '@eulerxyz/euler-v2-sdk'
import { ArcElement, Chart as ChartJS, Legend, Tooltip, type ChartData, type ChartOptions } from 'chart.js'
import { Doughnut } from 'vue-chartjs'
import { compactNumber } from '~/utils/string-utils'
import {
  buildOpenInterestModel,
  normalizeOpenInterestAddress,
  type OpenInterestCollateralInput,
} from '~/utils/vault/open-interest'

ChartJS.register(ArcElement, Tooltip, Legend)

const { vault, defaultOpen = false } = defineProps<{
  vault: EVault
  defaultOpen?: boolean
}>()

const { chainId } = useEulerAddresses()
const { get: registryGet } = useVaultRegistry()
const { getChartColors, isDark } = useThemeColors()
const {
  load: loadCollateralOpenInterest,
  getOpenInterestForVault,
  hasError,
  isLoaded: isOpenInterestLoaded,
  isLoading,
  isOpenInterestEnabled,
} = useCollateralOpenInterest()

const chartData = shallowRef<ChartData<'doughnut', number[], string> | null>(null)
const chartOptions = shallowRef<ChartOptions<'doughnut'> | null>(null)
const vaultDataKey = computed(() => normalizeOpenInterestAddress(vault.address))

const canLoadOpenInterest = computed(() =>
  isOpenInterestEnabled.value
  && vault.collaterals.some(ltv => ltv.currentLiquidationLTV > 0 || ltv.borrowLTV > 0),
)

const getCollateralInput = (address: string, valueUsd: number): OpenInterestCollateralInput => {
  const entry = registryGet(address)
  const collateral = entry?.vault as EVault | SecuritizeCollateralVault | undefined
  const fallbackLabel = `${address.slice(0, 6)}...${address.slice(-4)}`

  return {
    address,
    label: collateral?.asset.symbol || fallbackLabel,
    backingAssetAddress: collateral?.asset.address,
    valueUsd,
  }
}

const openInterestModel = computed(() => {
  const exposure: Record<string, number> = isOpenInterestLoaded.value ? getOpenInterestForVault(vault.address) : {}
  const collaterals = Object.entries(exposure).map(([address, valueUsd]) =>
    getCollateralInput(address, valueUsd),
  )
  const totalUsd = collaterals.reduce((sum, item) => sum + item.valueUsd, 0)

  return buildOpenInterestModel({
    collaterals,
    borrowedUsd: totalUsd,
    cashUsd: 0,
    maxCollateralNodes: 6,
  })
})

const hasOpenInterest = computed(() => openInterestModel.value.totalUsd > 0)
const nodes = computed(() => openInterestModel.value.collateralNodes)
const formatPercent = (value: number) => `${compactNumber(value, 1, 0)}%`
const vaultCountLabel = (count: number) => `${count} vault${count === 1 ? '' : 's'}`

const isSyntheticNode = (id: string) => id === 'other'

const getNodeAsset = (node: { id: string, label: string }) => ({
  address: node.id,
  symbol: node.label,
})

const readCssVar = (name: string) => {
  if (import.meta.server) return ''
  return getComputedStyle(document.body).getPropertyValue(name).trim()
}

const getSliceColors = () => [
  readCssVar('--accent-600'),
  '#4da3ff',
  readCssVar('--warning-500'),
  '#a78bfa',
  '#fb7185',
  readCssVar('--chart-line-b'),
].map(color => color || '#23c09b')

const renderChart = async () => {
  if (!hasOpenInterest.value) {
    chartData.value = null
    chartOptions.value = null
    return
  }

  await nextTick()
  const colors = getChartColors()
  const sliceColors = getSliceColors()

  chartData.value = {
    labels: nodes.value.map(node => node.label),
    datasets: [
      {
        data: nodes.value.map(node => node.valueUsd),
        backgroundColor: nodes.value.map((_, index) => sliceColors[index % sliceColors.length]),
        borderColor: readCssVar('--bg-surface-secondary') || colors.tooltip.bg,
        borderWidth: 3,
        hoverOffset: 6,
      },
    ],
  }

  chartOptions.value = {
    responsive: true,
    maintainAspectRatio: false,
    cutout: '58%',
    plugins: {
      legend: {
        display: false,
      },
      tooltip: {
        backgroundColor: colors.tooltip.bg,
        borderColor: colors.tooltip.border,
        borderWidth: 1,
        titleColor: colors.tooltip.text,
        bodyColor: colors.tooltip.textMuted,
        displayColors: false,
        callbacks: {
          label: (context) => {
            const node = nodes.value[context.dataIndex]
            if (!node) return ''
            return `${node.displayValue} (${formatPercent(node.percentage)})`
          },
        },
      },
    },
  }
}

const loadOpenInterest = async () => {
  if (!canLoadOpenInterest.value || !chainId.value || !vault.address) return
  await loadCollateralOpenInterest()
}

watch(
  [chainId, canLoadOpenInterest, vaultDataKey],
  () => {
    void loadOpenInterest()
  },
  { immediate: true },
)

watch([openInterestModel, isDark], () => {
  void renderChart()
}, { deep: true })
</script>

<template>
  <VaultOverviewAccordionSection
    v-if="canLoadOpenInterest && (isLoading || hasError || hasOpenInterest)"
    title="Exposure"
    :default-open="defaultOpen"
    content-class="flex flex-col gap-16"
  >
    <div
      v-if="isLoading"
      class="h-[220px] rounded-12 bg-surface animate-pulse"
    />

    <div
      v-else-if="hasError"
      class="rounded-12 border border-line-subtle bg-surface p-16 text-p3 text-content-secondary"
    >
      Exposure is unavailable for this vault right now.
    </div>

    <div
      v-else
      class="grid gap-18 tablet:grid-cols-[minmax(180px,220px)_1fr] tablet:items-center"
      data-id="borrow-open-interest"
      :data-key="vaultDataKey"
      :data-vault-address="vaultDataKey"
    >
      <div class="relative mx-auto h-[220px] w-full max-w-[220px]">
        <Doughnut
          v-if="chartData && chartOptions"
          :data="chartData"
          :options="chartOptions"
        />
        <div class="pointer-events-none absolute inset-0 flex flex-col items-center justify-center text-center">
          <p
            class="text-h4 text-content-primary"
            data-id="data-point"
            :data-key="vaultDataKey"
            data-field="open-interest-total"
            :data-value="openInterestModel.rightNodes.borrowed.displayValue"
          >
            {{ openInterestModel.rightNodes.borrowed.displayValue }}
          </p>
          <p class="text-p4 text-content-tertiary">
            borrowed
          </p>
        </div>
      </div>

      <div class="flex min-w-0 flex-col gap-10">
        <div class="flex min-w-0 items-center justify-between gap-12">
          <div class="min-w-0">
            <p class="text-p3 font-medium text-content-primary">
              Borrow exposure by asset
            </p>
          </div>
        </div>

        <div class="flex flex-col gap-8">
          <div
            v-for="(node, index) in nodes"
            :key="node.id"
            class="rounded-[10px] border border-line-subtle bg-surface p-10"
            data-id="data-point"
            :data-list="`borrow-open-interest:${vaultDataKey}`"
            :data-key="node.id"
            data-field="open-interest-backing-asset"
            :data-value="node.label"
          >
            <div class="flex min-w-0 items-center justify-between gap-12">
              <div class="flex min-w-0 items-center gap-8">
                <span
                  class="h-10 w-10 shrink-0 rounded-full"
                  :style="{ backgroundColor: chartData?.datasets[0]?.backgroundColor?.[index] as string }"
                />
                <AssetAvatar
                  v-if="!isSyntheticNode(node.id)"
                  :asset="getNodeAsset(node)"
                  size="20"
                />
                <span class="truncate text-p3 font-medium text-content-primary">
                  {{ node.label }}
                </span>
                <span
                  v-if="node.vaultCount > 1"
                  class="shrink-0 rounded-full bg-accent-500/10 px-6 py-2 text-p5 text-content-accent"
                >
                  {{ vaultCountLabel(node.vaultCount) }}
                </span>
              </div>
              <span class="shrink-0 text-p4 text-content-secondary">
                {{ formatPercent(node.percentage) }}
              </span>
            </div>
            <p class="mt-4 pl-18 text-p4 text-content-tertiary">
              {{ node.displayValue }}
            </p>
          </div>
        </div>
      </div>
    </div>
  </VaultOverviewAccordionSection>
</template>
