<script setup lang="ts">
import { computed } from 'vue'
import { useTxBatch } from '~/composables/useTxBatch'

// Laptop-only floating drawer. On small screens the batch is a full page
// (pages/batch.vue) reached from the bottom-nav "Batch" item.
const { entryCount, isSimulating, isDrawerOpen, toggleDrawer } = useTxBatch()

const hasBatch = computed(() => entryCount.value > 0)
</script>

<template>
  <div
    v-if="hasBatch"
    class="hidden laptop:block fixed z-[120] right-[calc(16px+var(--scroll-lock-shift,0px))] bottom-16 w-[320px] max-w-[92vw] rounded-16 border border-accent-600 bg-card shadow-2xl text-content-primary"
    data-testid="batch-drawer"
  >
    <!-- Header -->
    <button
      type="button"
      class="w-full px-16 py-12 border-b border-line-default"
      @click="toggleDrawer"
    >
      <div class="flex items-center justify-between">
        <span class="flex items-center gap-8 text-p2 font-semibold">
          <span class="inline-flex items-center justify-center w-22 h-22 rounded-full bg-accent-600 text-content-inverse text-p3 font-semibold">
            {{ entryCount }}
          </span>
          Transaction batch
        </span>
        <span class="flex items-center text-content-tertiary">
          <UiLoader
            v-if="isSimulating"
            class="!w-16 !h-16"
          />
          <SvgIcon
            v-else
            name="arrow-down"
            class="!w-16 !h-16 transition-transform"
            :class="{ 'rotate-180': isDrawerOpen }"
          />
        </span>
      </div>
    </button>

    <BatchContents v-show="isDrawerOpen" />
  </div>
</template>
