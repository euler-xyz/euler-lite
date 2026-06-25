<script setup lang="ts">
import { isEVault, type EVault, type SecuritizeCollateralVault } from '@eulerxyz/euler-v2-sdk'
import { getAddress } from 'viem'
import type { MarketGroup } from '~/entities/lend-discovery'
import { findVault, type CollateralMatrixData } from '~/utils/discoveryCalculations'
import { compactNumber } from '~/utils/string-utils'
import {
  buildOpenInterestModel,
  findOpenInterestMapForVault,
  normalizeOpenInterestAddress,
  type OpenInterestCollateralInput,
  type OpenInterestCollateralMapResponse,
} from '~/utils/vault/open-interest'

const { market, matrix } = defineProps<{
  market: MarketGroup
  matrix: CollateralMatrixData
}>()

const { chainId } = useEulerAddresses()

const isLoading = ref(false)
const hasError = ref(false)
const collateralExposureUsd = ref<Record<string, Record<string, number>>>({})
const refreshedAt = ref<string | null>(null)
const expandedRows = ref<Set<string>>(new Set())

const COLLAPSED_NODE_COUNT = 3

const borrowVaults = computed(() =>
  matrix.columns
    .map(column => findVault(market, column.address))
    .filter((vault): vault is EVault => !!vault && isEVault(vault)),
)

const getCollateralInput = (address: string, valueUsd: number): OpenInterestCollateralInput => {
  const vault = findVault(market, address) as EVault | SecuritizeCollateralVault | null
  const fallbackLabel = `${address.slice(0, 6)}...${address.slice(-4)}`

  return {
    address,
    label: vault?.asset.symbol || fallbackLabel,
    backingAssetAddress: vault?.asset.address,
    valueUsd,
  }
}

const rows = computed(() =>
  borrowVaults.value.map((vault) => {
    const exposure = findOpenInterestMapForVault(collateralExposureUsd.value, vault.address)
    const collaterals = Object.entries(exposure).map(([address, valueUsd]) =>
      getCollateralInput(address, valueUsd),
    )
    const totalUsd = collaterals.reduce((sum, item) => sum + item.valueUsd, 0)
    const model = buildOpenInterestModel({
      collaterals,
      borrowedUsd: totalUsd,
      cashUsd: 0,
      maxCollateralNodes: 5,
    })

    return {
      vault,
      model,
      totalUsd,
    }
  }).filter(row => row.totalUsd > 0)
    .sort((a, b) => b.totalUsd - a.totalUsd),
)

const formatPercent = (value: number) => `${compactNumber(value, 1, 0)}%`

const barWidth = (value: number) => ({
  width: `${Math.max(2, Math.min(100, value))}%`,
})

const vaultCountLabel = (count: number) => `${count} vault${count === 1 ? '' : 's'}`
const groupCountLabel = (count: number) => `${count} group${count === 1 ? '' : 's'}`

const rowKey = (vault: EVault) => normalizeOpenInterestAddress(vault.address)

const isRowExpanded = (vault: EVault) => expandedRows.value.has(rowKey(vault))

const toggleRowExpanded = (vault: EVault) => {
  const key = rowKey(vault)
  const next = new Set(expandedRows.value)
  if (next.has(key)) next.delete(key)
  else next.add(key)
  expandedRows.value = next
}

const visibleNodes = (row: (typeof rows.value)[number]) =>
  isRowExpanded(row.vault)
    ? row.model.collateralNodes
    : row.model.collateralNodes.slice(0, COLLAPSED_NODE_COUNT)

const hiddenNodeCount = (row: (typeof rows.value)[number]) =>
  Math.max(0, row.model.collateralNodes.length - visibleNodes(row).length)

const nodeShowMoreLabel = (row: (typeof rows.value)[number]) =>
  isRowExpanded(row.vault) ? 'Show less' : `Show more (${hiddenNodeCount(row)})`

const loadOpenInterest = async () => {
  if (!chainId.value || !borrowVaults.value.length) return

  isLoading.value = true
  hasError.value = false

  try {
    const query = `chainId=${encodeURIComponent(String(chainId.value))}`
    const response = await $fetch<OpenInterestCollateralMapResponse>(`/api/v3/evk/vaults/open-interest/by-collateral?${query}`)
    collateralExposureUsd.value = response.data ?? {}
    refreshedAt.value = response.meta?.refreshedAt ?? response.meta?.calculationTimestamp ?? null
  }
  catch {
    hasError.value = true
    collateralExposureUsd.value = {}
    refreshedAt.value = null
  }
  finally {
    isLoading.value = false
  }
}

watch(
  [chainId, () => borrowVaults.value.map(vault => normalizeOpenInterestAddress(vault.address)).join(',')],
  () => {
    void loadOpenInterest()
  },
  { immediate: true },
)
</script>

<template>
  <div
    class="border-t border-line-subtle px-16 pb-16"
    data-id="discovery-market-open-interest"
    :data-market-id="market.id"
  >
    <div class="flex flex-wrap items-center justify-between gap-8 py-12">
      <div>
        <h4 class="text-p3 font-medium text-content-primary">
          Open interest
        </h4>
        <p class="text-p4 text-content-tertiary">
          Borrow demand grouped by backing asset.
        </p>
      </div>
      <span
        v-if="refreshedAt"
        class="rounded-full border border-line-subtle bg-surface px-10 py-5 text-p4 text-content-secondary"
      >
        Updated {{ new Date(refreshedAt).toLocaleString() }}
      </span>
    </div>

    <div
      v-if="isLoading"
      class="h-160 rounded-12 bg-surface-secondary animate-pulse"
    />

    <div
      v-else-if="hasError"
      class="rounded-12 border border-line-subtle bg-surface-secondary p-16 text-p3 text-content-secondary"
    >
      Open interest is unavailable for this market right now.
    </div>

    <div
      v-else-if="rows.length"
      class="flex flex-col gap-12"
    >
      <div class="grid gap-10 tablet:grid-cols-2">
        <div
          v-for="row in rows"
          :key="row.vault.address"
          class="rounded-12 border border-line-subtle bg-surface-secondary p-12"
          data-id="discovery-open-interest-row"
          :data-key="getAddress(row.vault.address).toLowerCase()"
          :data-vault-address="getAddress(row.vault.address).toLowerCase()"
        >
          <div class="mb-10 flex min-w-0 items-start justify-between gap-12">
            <div class="min-w-0">
              <p class="truncate text-p3 font-medium text-content-primary">
                {{ row.vault.asset.symbol }}
              </p>
              <p
                class="text-p4 text-content-tertiary"
                data-id="data-point"
                :data-key="getAddress(row.vault.address).toLowerCase()"
                data-field="open-interest-total"
                :data-value="row.model.rightNodes.borrowed.displayValue"
              >
                {{ row.model.rightNodes.borrowed.displayValue }} open interest
              </p>
            </div>
            <span class="rounded-full bg-surface px-8 py-4 text-p4 text-content-secondary">
              {{ groupCountLabel(row.model.collateralNodes.length) }}
            </span>
          </div>

          <div class="flex flex-col gap-8">
            <div
              v-for="node in visibleNodes(row)"
              :key="node.id"
              class="rounded-8 bg-surface p-10"
              data-id="data-point"
              :data-list="`open-interest:${getAddress(row.vault.address).toLowerCase()}`"
              :data-key="node.id"
              data-field="open-interest-backing-asset"
              :data-value="node.label"
            >
              <div class="mb-6 flex min-w-0 items-center justify-between gap-8">
                <div class="flex min-w-0 items-center gap-6">
                  <span class="truncate text-p3 text-content-primary">{{ node.label }}</span>
                  <span
                    v-if="node.vaultCount > 1"
                    class="shrink-0 rounded-full bg-accent-500/10 px-6 py-2 text-p5 text-content-accent"
                  >
                    {{ vaultCountLabel(node.vaultCount) }}
                  </span>
                </div>
                <span class="shrink-0 text-p4 text-content-secondary">{{ formatPercent(node.percentage) }}</span>
              </div>
              <div class="h-4 overflow-hidden rounded-full bg-surface-secondary">
                <div
                  class="h-full rounded-full bg-accent-500"
                  :style="barWidth(node.percentage)"
                />
              </div>
              <p class="mt-6 text-p4 text-content-tertiary">
                {{ node.displayValue }}
              </p>
            </div>

            <button
              v-if="row.model.collateralNodes.length > COLLAPSED_NODE_COUNT"
              class="self-start text-p4 font-medium text-content-accent hover:text-accent-600 transition-colors cursor-pointer"
              type="button"
              data-id="discovery-open-interest-row-show-more"
              :data-key="getAddress(row.vault.address).toLowerCase()"
              :aria-expanded="isRowExpanded(row.vault)"
              @click.stop="toggleRowExpanded(row.vault)"
            >
              {{ nodeShowMoreLabel(row) }}
            </button>
          </div>
        </div>
      </div>
    </div>

    <div
      v-else
      class="rounded-12 border border-line-subtle bg-surface-secondary p-16 text-p3 text-content-secondary"
    >
      No active open interest for this market.
    </div>
  </div>
</template>
