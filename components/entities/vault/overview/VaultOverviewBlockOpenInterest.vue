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

const flowY = (index: number, count: number) => {
  if (count <= 1) return 130
  const top = 44
  const bottom = 216
  return top + (bottom - top) * (index / (count - 1))
}

const rightY = (id: string) => id === 'borrowed' ? 102 : 178

const flowPath = (index: number, count: number) => {
  const y = flowY(index, count)
  const targetY = rightY('borrowed')
  return `M 168 ${y} C 280 ${y}, 372 ${targetY}, 504 ${targetY}`
}

const nodeHeight = (valueUsd: number) => {
  if (model.value.totalUsd <= 0) return 8
  return Math.max(10, Math.min(96, valueUsd / model.value.totalUsd * 180))
}

const formatPercent = (value: number) => `${compactNumber(value, 1, 0)}%`

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
      <div class="flex flex-wrap items-center gap-x-20 gap-y-8 text-p3 text-content-secondary">
        <span v-if="borrowerCount !== null">{{ borrowerCount }} borrowers</span>
        <span v-if="refreshedAt">Updated {{ new Date(refreshedAt).toLocaleString() }}</span>
      </div>

      <div class="w-full overflow-hidden">
        <svg
          class="h-[260px] w-full text-content-primary"
          viewBox="0 0 720 260"
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
                stop-color="var(--c-accent-500)"
                stop-opacity="0.68"
              />
              <stop
                offset="100%"
                stop-color="var(--c-chart-line-b)"
                stop-opacity="0.76"
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
              opacity="0.72"
            >
              <title>{{ `${flow.source.label} exposure: ${flow.source.displayValue} (${formatPercent(flow.source.percentage)})` }}</title>
            </path>
          </g>

          <g
            v-for="(node, index) in model.collateralNodes"
            :key="node.id"
            :transform="`translate(24 ${flowY(index, model.collateralNodes.length) - nodeHeight(node.valueUsd) / 2})`"
          >
            <rect
              width="132"
              :height="nodeHeight(node.valueUsd)"
              rx="6"
              fill="var(--c-surface)"
              stroke="var(--c-line-subtle)"
            >
              <title>{{ `${node.label}: ${node.displayValue} (${formatPercent(node.percentage)})` }}</title>
            </rect>
            <text
              x="12"
              y="18"
              class="fill-current text-[13px] font-medium"
            >
              {{ node.label }}
            </text>
            <text
              x="12"
              y="36"
              class="fill-[var(--c-content-secondary)] text-[12px]"
            >
              {{ node.displayValue }}
            </text>
          </g>

          <g
            v-for="node in rightRows"
            :key="node.id"
            :transform="`translate(532 ${rightY(node.id) - nodeHeight(node.valueUsd) / 2})`"
          >
            <rect
              width="164"
              :height="nodeHeight(node.valueUsd)"
              rx="6"
              :fill="node.id === 'borrowed' ? 'var(--c-accent-500)' : 'var(--c-surface)'"
              :fill-opacity="node.id === 'borrowed' ? 0.18 : 1"
              stroke="var(--c-line-subtle)"
            >
              <title>{{ `${node.label}: ${node.displayValue} (${formatPercent(node.percentage)})` }}</title>
            </rect>
            <text
              x="12"
              y="18"
              class="fill-current text-[13px] font-medium"
            >
              {{ node.label }}
            </text>
            <text
              x="12"
              y="36"
              class="fill-[var(--c-content-secondary)] text-[12px]"
            >
              {{ node.displayValue }} · {{ formatPercent(node.percentage) }}
            </text>
          </g>
        </svg>
      </div>

      <div class="grid gap-8 text-p3 text-content-secondary tablet:grid-cols-2">
        <div
          v-for="node in model.collateralNodes"
          :key="`row-${node.id}`"
          class="flex min-w-0 items-center justify-between gap-12"
        >
          <span class="truncate text-content-primary">{{ node.label }}</span>
          <span class="shrink-0">{{ node.displayValue }} · {{ formatPercent(node.percentage) }}</span>
        </div>
      </div>
    </template>
  </VaultOverviewAccordionSection>
</template>
