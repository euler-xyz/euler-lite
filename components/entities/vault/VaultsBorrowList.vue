<script setup lang="ts">
import type { AnyBorrowVaultPair } from '~/types/borrow-pair'
import { LIST_INITIAL_BATCH_ROWS, LIST_ROW_HEIGHT_PX } from '~/entities/tuning-constants'

const props = defineProps<{ items: AnyBorrowVaultPair[] }>()

// Progressive rendering. The dominant cost of a large pair list is Vue's
// per-instance setup (each VaultBorrowItem has a nontrivial <script setup>
// plus several sub-components), not paint. Rendering only the first batch
// on initial paint keeps time-to-visible low; the remainder is inserted
// one frame later.
//
// Watch `items.length` (not `items`) so an incremental registry update that
// swaps the array reference but keeps the same length doesn't retrigger
// the initial-batch ramp (which would otherwise flicker the table).
//
// To prevent scroll-restoration from jumping when the list grows, reserve
// the full expected height up front via a spacer. The list container is
// the same height from first paint onward, so anything that scrolls based
// on document height (router scroll restoration, anchor links) settles on
// the final DOM geometry rather than the partial one.
const displayedCount = ref(Math.min(props.items.length, LIST_INITIAL_BATCH_ROWS))

watch(() => props.items.length, (total) => {
  if (total <= LIST_INITIAL_BATCH_ROWS) {
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
  const missing = props.items.length - displayedCount.value
  return missing > 0 ? missing * LIST_ROW_HEIGHT_PX : 0
})
</script>

<template>
  <div
    class="flex flex-col gap-8"
    data-id="vault-list"
    data-list="borrow-pair"
    :data-count="items.length"
    :data-rendered-count="visibleItems.length"
  >
    <VaultBorrowItem
      v-for="(pair, index) in visibleItems"
      :key="`${pair.collateral.address}-${pair.borrow.address}`"
      :pair="pair"
      class="animate-fade-in-up"
      :style="{ animationDelay: `${Math.min(index * 0.03, 0.2)}s` }"
    />
    <div
      v-if="reservedSpacerPx > 0"
      aria-hidden="true"
      :style="{ height: `${reservedSpacerPx}px` }"
    />
  </div>
</template>
