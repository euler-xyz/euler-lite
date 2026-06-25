<script setup lang="ts">
import type { EVault, SecuritizeCollateralVault } from '@eulerxyz/euler-v2-sdk'
import { getAddress } from 'viem'
import { getAssetUsdValueOrZero } from '~/utils/sdk-prices'
import { compactNumber } from '~/utils/string-utils'
import { isVaultBorrowable } from '~/utils/vault/classification'
import {
  buildOpenInterestModel,
  findOpenInterestMapForVault,
  normalizeOpenInterestAddress,
  type OpenInterestCollateralInput,
  type OpenInterestCollateralMapResponse,
  type OpenInterestResponse,
} from '~/utils/vault/open-interest'

const { vault, defaultOpen = false } = defineProps<{ vault: EVault, defaultOpen?: boolean }>()

const { chainId } = useEulerAddresses()
const { get: registryGet } = useVaultRegistry()

const isLoading = ref(false)
const hasError = ref(false)
const collateralExposureUsd = ref<Record<string, number>>({})
const borrowerCount = ref<number | null>(null)
const refreshedAt = ref<string | null>(null)
const borrowedUsd = ref(0)
const cashUsd = ref(0)

const vaultAddress = computed(() => normalizeOpenInterestAddress(vault.address))
const isBorrowable = computed(() => isVaultBorrowable(vault))

const getVaultLabel = (address: string): string => {
  const entry = registryGet(address)
  const collateralVault = entry?.vault as EVault | SecuritizeCollateralVault | undefined
  return collateralVault?.asset.symbol || `${address.slice(0, 6)}...${address.slice(-4)}`
}

const collateralInputs = computed<OpenInterestCollateralInput[]>(() =>
  Object.entries(collateralExposureUsd.value).map(([address, valueUsd]) => ({
    address,
    label: getVaultLabel(address),
    valueUsd,
  })),
)

const model = computed(() => buildOpenInterestModel({
  collaterals: collateralInputs.value,
  cashUsd: cashUsd.value,
  borrowedUsd: borrowedUsd.value,
}))

const hasChartData = computed(() =>
  model.value.collateralNodes.length > 0
  || model.value.rightNodes.cash.valueUsd > 0
  || model.value.rightNodes.borrowed.valueUsd > 0,
)

const shouldRender = computed(() => isBorrowable.value && (isLoading.value || hasError.value || hasChartData.value))

const rightRows = computed(() => [
  model.value.rightNodes.borrowed,
  model.value.rightNodes.cash,
].filter(node => node.valueUsd > 0))

const MIN_GRAPH_HEIGHT = 260
const COLLATERAL_ROW_HEIGHT = 84
const RIGHT_ROW_OFFSET = 56

const graphHeight = computed(() => Math.max(
  MIN_GRAPH_HEIGHT,
  Math.max(1, model.value.collateralNodes.length) * COLLATERAL_ROW_HEIGHT,
))

const graphHeightStyle = computed(() => ({
  '--open-interest-graph-height': `${graphHeight.value}px`,
}))

const flowY = (index: number, count: number) => {
  if (count <= 1) return graphHeight.value / 2
  const top = 40
  const bottom = graphHeight.value - 40
  return top + (bottom - top) * (index / (count - 1))
}

const rightY = (id: string) => {
  const middle = graphHeight.value / 2
  return id === 'borrowed' ? middle - RIGHT_ROW_OFFSET : middle + RIGHT_ROW_OFFSET
}

const flowPath = (index: number, count: number) => {
  const y = flowY(index, count)
  const targetY = rightY('borrowed')
  return `M 6 ${y} C 40 ${y}, 62 ${targetY}, 96 ${targetY}`
}

const formatPercent = (value: number) => `${compactNumber(value, 1, 0)}%`

const graphTop = (y: number) => ({
  '--open-interest-node-top': `${y / graphHeight.value * 100}%`,
})

const barWidth = (value: number) => ({
  width: `${Math.max(2, Math.min(100, value))}%`,
})

const loadOpenInterest = async () => {
  if (!chainId.value || !isBorrowable.value) return

  isLoading.value = true
  hasError.value = false

  try {
    const query = `chainId=${encodeURIComponent(String(chainId.value))}`
    const [openInterest, byCollateral] = await Promise.all([
      $fetch<OpenInterestResponse>(`/api/v3/evk/vaults/open-interest?${query}&vault=${encodeURIComponent(getAddress(vault.address))}&limit=1`),
      $fetch<OpenInterestCollateralMapResponse>(`/api/v3/evk/vaults/open-interest/by-collateral?${query}`),
    ])

    const row = openInterest.data?.find(item => normalizeOpenInterestAddress(item.vault) === vaultAddress.value)
    borrowerCount.value = row?.borrowerCount ?? null
    refreshedAt.value = byCollateral.meta?.refreshedAt ?? byCollateral.meta?.calculationTimestamp ?? row?.timestamp ?? null
    collateralExposureUsd.value = findOpenInterestMapForVault(byCollateral.data, vault.address)
  }
  catch {
    hasError.value = true
    collateralExposureUsd.value = {}
    borrowerCount.value = null
    refreshedAt.value = null
  }
  finally {
    isLoading.value = false
  }
}

watchEffect(async () => {
  borrowedUsd.value = await getAssetUsdValueOrZero(vault.totalBorrowed, vault, 'off-chain')
  cashUsd.value = await getAssetUsdValueOrZero(vault.availableLiquidity, vault, 'off-chain')
})

watch(
  [chainId, vaultAddress, isBorrowable],
  () => {
    void loadOpenInterest()
  },
  { immediate: true },
)
</script>

<template>
  <VaultOverviewAccordionSection
    v-if="shouldRender"
    title="Open interest"
    :default-open="defaultOpen"
    content-class="flex flex-col gap-20"
  >
    <div
      v-if="isLoading"
      class="h-[260px] rounded-lg bg-surface animate-pulse"
    />

    <div
      v-else-if="hasError"
      class="rounded-lg border border-line-subtle p-16 text-p2 text-content-secondary"
    >
      Open interest is unavailable for this vault right now.
    </div>

    <template v-else>
      <div class="flex flex-wrap items-center gap-8 text-p3 text-content-secondary">
        <span
          v-if="borrowerCount !== null"
          class="rounded-full border border-line-subtle bg-surface px-12 py-6"
        >
          {{ borrowerCount }} borrowers
        </span>
        <span
          v-if="refreshedAt"
          class="rounded-full border border-line-subtle bg-surface px-12 py-6"
        >
          Updated {{ new Date(refreshedAt).toLocaleString() }}
        </span>
      </div>

      <div class="overflow-hidden rounded-12 border border-line-subtle bg-surface p-14">
        <div class="mb-10 grid grid-cols-[minmax(148px,178px)_minmax(88px,1fr)_minmax(176px,220px)] items-center gap-14 mobile:hidden">
          <p class="text-p4 font-medium text-content-secondary">
            Collateral backing debt
          </p>
          <div class="h-px bg-line-subtle" />
          <p class="text-p4 font-medium text-content-secondary">
            Vault composition
          </p>
        </div>

        <div class="grid grid-cols-[minmax(148px,178px)_minmax(88px,1fr)_minmax(176px,220px)] gap-14 mobile:flex mobile:flex-col">
          <div
            class="relative h-[var(--open-interest-graph-height)] mobile:flex mobile:h-auto mobile:flex-col mobile:gap-8"
            :style="graphHeightStyle"
          >
            <div
              v-for="(node, index) in model.collateralNodes"
              :key="node.id"
              class="absolute left-0 top-[var(--open-interest-node-top)] z-10 w-full -translate-y-1/2 rounded-8 border border-line-subtle bg-surface-elevated p-10 shadow-card mobile:relative mobile:top-auto mobile:translate-y-0"
              :style="graphTop(flowY(index, model.collateralNodes.length))"
              :title="`${node.label}: ${node.displayValue} (${formatPercent(node.percentage)})`"
            >
              <div class="flex min-w-0 items-start justify-between gap-8">
                <span class="truncate text-p3 font-medium text-content-primary">{{ node.label }}</span>
                <span class="shrink-0 rounded-full bg-accent-500/10 px-6 py-2 text-p5 text-content-accent">{{ formatPercent(node.percentage) }}</span>
              </div>
              <div class="mt-7 h-4 overflow-hidden rounded-full bg-surface-secondary">
                <div
                  class="h-full rounded-full bg-accent-500"
                  :style="barWidth(node.percentage)"
                />
              </div>
              <p class="mt-6 truncate text-p4 text-content-tertiary">
                {{ node.displayValue }}
              </p>
            </div>
          </div>

          <svg
            class="h-[var(--open-interest-graph-height)] w-full self-stretch mobile:hidden"
            :style="graphHeightStyle"
            :viewBox="`0 0 100 ${graphHeight}`"
            preserveAspectRatio="none"
            role="img"
            aria-label="Open interest flow from collateral assets to borrowed liquidity"
          >
            <defs>
              <linearGradient
                id="open-interest-flow"
                x1="0"
                x2="1"
                y1="0"
                y2="0"
              >
                <stop
                  offset="0%"
                  stop-color="var(--accent-500)"
                  stop-opacity="0.34"
                />
                <stop
                  offset="100%"
                  stop-color="var(--chart-line-b)"
                  stop-opacity="0.64"
                />
              </linearGradient>
            </defs>

            <g
              v-for="(flow, index) in model.flows"
              :key="flow.id"
            >
              <path
                :d="flowPath(index, model.flows.length)"
                fill="none"
                stroke="url(#open-interest-flow)"
                stroke-linecap="round"
                :stroke-width="flow.width"
                opacity="0.84"
                vector-effect="non-scaling-stroke"
              >
                <title>{{ `${flow.source.label} exposure: ${flow.source.displayValue} (${formatPercent(flow.source.percentage)})` }}</title>
              </path>
            </g>
          </svg>

          <div
            class="relative h-[var(--open-interest-graph-height)] mobile:flex mobile:h-auto mobile:flex-col mobile:gap-8"
            :style="graphHeightStyle"
          >
            <div
              v-for="node in rightRows"
              :key="node.id"
              class="absolute right-0 top-[var(--open-interest-node-top)] z-10 w-full -translate-y-1/2 rounded-8 border p-12 shadow-card mobile:relative mobile:top-auto mobile:translate-y-0"
              :class="node.id === 'borrowed'
                ? 'border-line-emphasis bg-surface-elevated'
                : 'border-line-subtle bg-surface-elevated'"
              :style="graphTop(rightY(node.id))"
              :title="`${node.label}: ${node.displayValue} (${formatPercent(node.percentage)})`"
            >
              <div class="flex min-w-0 items-start justify-between gap-8">
                <span class="truncate text-p3 font-medium text-content-primary">{{ node.label }}</span>
                <span class="shrink-0 rounded-full bg-surface-secondary px-6 py-2 text-p5 text-content-tertiary">{{ formatPercent(node.percentage) }}</span>
              </div>
              <div class="mt-7 h-4 overflow-hidden rounded-full bg-surface-secondary">
                <div
                  class="h-full rounded-full"
                  :class="node.id === 'borrowed' ? 'bg-accent-500' : 'bg-content-muted'"
                  :style="barWidth(node.percentage)"
                />
              </div>
              <p class="mt-6 truncate text-p4 text-content-tertiary">
                {{ node.displayValue }}
              </p>
            </div>
          </div>
        </div>
      </div>

      <div class="grid gap-8 text-p3 text-content-secondary laptop:grid-cols-2">
        <div
          v-for="node in model.collateralNodes"
          :key="`row-${node.id}`"
          class="grid min-w-0 grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-10 rounded-8 bg-surface px-12 py-8"
        >
          <span class="truncate text-content-primary">{{ node.label }}</span>
          <span class="shrink-0">{{ node.displayValue }}</span>
          <span class="shrink-0 text-content-tertiary">{{ formatPercent(node.percentage) }}</span>
        </div>
      </div>
    </template>
  </VaultOverviewAccordionSection>
</template>
