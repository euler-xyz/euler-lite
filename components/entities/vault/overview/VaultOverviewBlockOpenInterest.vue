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
  const top = 52
  const bottom = 208
  return top + (bottom - top) * (index / (count - 1))
}

const rightY = (id: string) => id === 'borrowed' ? 104 : 176

const flowPath = (index: number, count: number) => {
  const y = flowY(index, count)
  const targetY = rightY('borrowed')
  return `M 178 ${y} C 270 ${y}, 342 ${targetY}, 420 ${targetY}`
}

const formatPercent = (value: number) => `${compactNumber(value, 1, 0)}%`

const graphTop = (y: number) => ({
  top: `${y / 260 * 100}%`,
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

      <div class="relative h-[300px] w-full overflow-hidden rounded-12 border border-line-subtle bg-surface p-16">
        <svg
          class="pointer-events-none absolute inset-16 h-[calc(100%-32px)] w-[calc(100%-32px)]"
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
                stop-color="var(--accent-500)"
                stop-opacity="0.42"
              />
              <stop
                offset="100%"
                stop-color="var(--chart-line-b)"
                stop-opacity="0.56"
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
        </svg>

        <div
          v-for="(node, index) in model.collateralNodes"
          :key="node.id"
          class="absolute left-16 z-10 flex h-52 w-[178px] -translate-y-1/2 flex-col justify-center rounded-8 border border-line-subtle bg-surface-elevated px-12 shadow-card"
          :style="graphTop(flowY(index, model.collateralNodes.length))"
          :title="`${node.label}: ${node.displayValue} (${formatPercent(node.percentage)})`"
        >
          <span class="truncate text-p3 font-medium text-content-primary">{{ node.label }}</span>
          <span class="truncate text-p4 text-content-tertiary">{{ node.displayValue }} · {{ formatPercent(node.percentage) }}</span>
        </div>

        <div
          v-for="node in rightRows"
          :key="node.id"
          class="absolute right-16 z-10 flex h-56 w-[220px] -translate-y-1/2 flex-col justify-center rounded-8 border px-14 shadow-card"
          :class="node.id === 'borrowed'
            ? 'border-accent-500/30 bg-accent-500/10'
            : 'border-line-subtle bg-surface-elevated'"
          :style="graphTop(rightY(node.id))"
          :title="`${node.label}: ${node.displayValue} (${formatPercent(node.percentage)})`"
        >
          <span class="truncate text-p3 font-medium text-content-primary">{{ node.label }}</span>
          <span class="truncate text-p4 text-content-tertiary">{{ node.displayValue }} · {{ formatPercent(node.percentage) }}</span>
        </div>
      </div>

      <div class="grid gap-8 text-p3 text-content-secondary tablet:grid-cols-2">
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
