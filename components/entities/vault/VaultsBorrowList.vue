<script setup lang="ts">
import type { AnyBorrowVaultPair } from '~/types/borrow-pair'
import { LIST_INITIAL_BATCH_ROWS, LIST_ROW_HEIGHT_PX, LIST_EAGER_RENDER_ROWS } from '~/entities/tuning-constants'
import { fullListRenderOptIn } from '~/utils/debug-flags'

const props = defineProps<{ items: AnyBorrowVaultPair[] }>()

// Windowed rendering. Each VaultBorrowItem is expensive (nontrivial
// <script setup>, ~10 modal-trigger subcomponents, a per-row price
// watchEffect) and the pair list is combinatorial in collaterals × borrow
// vaults (400+ rows), so keeping every row mounted OOM-crashes mobile
// browsers. UiLazyListItem mounts only the rows near the viewport and swaps
// the rest for fixed-height placeholders, keeping DOM and JS heap bounded
// regardless of list length.
//
// Parity captures scrape the full list DOM, so `?fullrender` /
// `localStorage.euler_full_render=1` disables windowing and falls back to
// the previous progressive two-phase render (initial batch, then the rest
// one frame later, with a spacer reserving the final document height for
// scroll restoration).
const isWindowed = !fullListRenderOptIn

const displayedCount = ref(isWindowed ? props.items.length : Math.min(props.items.length, LIST_INITIAL_BATCH_ROWS))

// Watch `items.length` (not `items`) so an incremental registry update that
// swaps the array reference but keeps the same length doesn't retrigger
// the initial-batch ramp (which would otherwise flicker the table).
watch(() => props.items.length, (total) => {
  if (isWindowed || total <= LIST_INITIAL_BATCH_ROWS) {
    displayedCount.value = total
    return
  }
  displayedCount.value = LIST_INITIAL_BATCH_ROWS
  void nextTick(() => {
    requestAnimationFrame(() => {
      displayedCount.value = total
    })
  })
}, { immediate: true })

const visibleItems = computed(() => props.items.slice(0, displayedCount.value))
const reservedSpacerPx = computed(() => {
  if (isWindowed) return 0
  const missing = props.items.length - displayedCount.value
  return missing > 0 ? missing * LIST_ROW_HEIGHT_PX : 0
})

// Shared placeholder height for rows that haven't been measured yet. Rows
// are near-uniform within a viewport class (mobile cards are several times
// taller than desktop rows), so the latest real measurement is a better
// estimate than the static constant.
const rowHeightEstimate = ref(LIST_ROW_HEIGHT_PX)
const onRowMeasured = (height: number) => {
  rowHeightEstimate.value = height
}
</script>

<template>
  <div
    class="flex flex-col gap-8"
    data-id="vault-list"
    data-list="borrow-pair"
    :data-count="items.length"
    :data-rendered-count="isWindowed ? undefined : visibleItems.length"
  >
    <UiLazyListItem
      v-for="(pair, index) in visibleItems"
      :key="`${pair.collateral.address}-${pair.borrow.address}`"
      :estimated-height="rowHeightEstimate"
      :eager="index < LIST_EAGER_RENDER_ROWS"
      :disabled="!isWindowed"
      placeholder-class="rounded-12 border border-line-default bg-surface shadow-card"
      @measured="onRowMeasured"
    >
      <VaultBorrowItem
        :pair="pair"
        class="animate-fade-in-up"
        :style="{ animationDelay: `${Math.min(index * 0.03, 0.2)}s` }"
      />
    </UiLazyListItem>
    <div
      v-if="reservedSpacerPx > 0"
      aria-hidden="true"
      :style="{ height: `${reservedSpacerPx}px` }"
    />
  </div>
</template>
