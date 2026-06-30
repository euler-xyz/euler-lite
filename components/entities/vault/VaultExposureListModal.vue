<script setup lang="ts">
import { compactNumber, formatCompactUsdValue } from '~/utils/string-utils'
import {
  sortVaultExposureDisplayItems,
  type ExposureValueState,
  type VaultExposureDisplayItem,
} from '~/utils/vault/exposure-display'

const {
  items,
  title = 'Exposure',
  valueState = 'ready',
  close = true,
  inline = false,
} = defineProps<{
  items: VaultExposureDisplayItem[]
  title?: string
  valueState?: ExposureValueState
  close?: boolean
  inline?: boolean
}>()

const sortedItems = computed(() => sortVaultExposureDisplayItems(items))
const totalUsd = computed(() =>
  sortedItems.value.reduce((sum, item) => sum + item.valueUsd, 0),
)

const formatValue = (item: VaultExposureDisplayItem) => {
  if (valueState === 'loading') return 'Loading'
  if (valueState === 'unavailable') return 'Unavailable'
  return formatCompactUsdValue(item.valueUsd)
}

const getPercent = (item: VaultExposureDisplayItem) => {
  if (valueState !== 'ready' || totalUsd.value <= 0) return 0
  return item.valueUsd / totalUsd.value * 100
}

const formatPercent = (item: VaultExposureDisplayItem) => {
  if (valueState !== 'ready') return '-'
  if (totalUsd.value <= 0) return '0%'
  return `${compactNumber(getPercent(item), 1, 0)}%`
}

const vaultCountLabel = (count: number) => `${count} vault${count === 1 ? '' : 's'}`
const displayLabel = (item: VaultExposureDisplayItem) => item.label ?? item.asset.symbol
const itemSources = (item: VaultExposureDisplayItem) => item.sources ?? []
const itemKey = (item: VaultExposureDisplayItem) => `${item.asset.address}:${displayLabel(item)}`
</script>

<template>
  <BaseModalWrapper
    :title="inline ? undefined : title"
    :close="close"
    :inline="inline"
  >
    <div
      v-if="sortedItems.length"
      class="flex w-full min-w-[320px] flex-col gap-6"
    >
      <div
        v-for="item in sortedItems"
        :key="itemKey(item)"
        class="grid min-w-0 grid-cols-[20px_minmax(0,1fr)_auto] items-center gap-10 rounded-8 border border-line-subtle bg-surface px-10 py-8"
      >
        <AssetAvatar
          class="shrink-0"
          :asset="item.asset"
          size="20"
        />
        <div class="min-w-0 flex-1">
          <div class="flex min-w-0 items-center gap-6">
            <span
              class="truncate text-p2 font-semibold text-content-primary"
              :title="displayLabel(item)"
            >
              {{ displayLabel(item) }}
            </span>
            <span
              v-if="!itemSources(item).length && item.vaultCount && item.vaultCount > 1"
              class="shrink-0 rounded-8 bg-neutral-100 px-6 py-2 text-p5 text-content-tertiary"
            >
              {{ vaultCountLabel(item.vaultCount) }}
            </span>
          </div>
          <div
            v-if="item.asset.name && item.asset.name !== item.asset.symbol"
            class="truncate text-p5 text-content-secondary"
            :title="item.asset.name"
          >
            {{ item.asset.name }}
          </div>
          <div
            v-if="itemSources(item).length"
            class="mt-2 flex min-w-0 flex-wrap items-center gap-x-4 gap-y-2 text-p5 text-content-secondary"
          >
            <span class="shrink-0 text-content-tertiary">Markets listed:</span>
            <template
              v-for="(source, sourceIdx) in itemSources(item)"
              :key="`${source.label}:${JSON.stringify(source.to ?? '')}`"
            >
              <NuxtLink
                v-if="source.to"
                :to="source.to"
                class="max-w-[180px] truncate underline transition-colors hover:text-accent-600"
              >
                {{ source.label }}
              </NuxtLink>
              <span
                v-else
                class="max-w-[180px] truncate"
              >
                {{ source.label }}
              </span>
              <span
                v-if="sourceIdx < itemSources(item).length - 1"
                class="text-content-tertiary"
              >,</span>
            </template>
          </div>
        </div>
        <div class="flex shrink-0 items-center gap-8 text-right">
          <div>
            <div class="text-p2 font-semibold text-content-primary">
              {{ formatValue(item) }}
            </div>
            <div class="text-p5 text-content-secondary">
              {{ formatPercent(item) }}
            </div>
          </div>
          <UiRadialProgress
            :value="getPercent(item)"
            :max="100"
            class="shrink-0 [--ui-radial-progress-active-color:var(--accent-600)] [--ui-radial-progress-background-color:var(--neutral-100)]"
          />
        </div>
      </div>
    </div>
    <div
      v-else
      class="w-[280px] py-16 text-center text-p3 text-content-secondary"
    >
      No active exposure.
    </div>
  </BaseModalWrapper>
</template>
