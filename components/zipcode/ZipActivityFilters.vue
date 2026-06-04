<script setup lang="ts">
// Activity filter chips (spec §10.9).
import type { ActivityFilter } from '~/types/zipcode'

const model = defineModel<ActivityFilter>({ default: 'all' })

const filters: { value: ActivityFilter, label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'deposits', label: 'Deposits' },
  { value: 'redemptions', label: 'Redemptions' },
  { value: 'claims', label: 'Claims' },
]
</script>

<template>
  <div
    class="inline-flex items-center gap-4 p-4 rounded-12"
    style="background: var(--zip-surface-muted); border: 1px solid var(--zip-border)"
    role="tablist"
  >
    <button
      v-for="f in filters"
      :key="f.value"
      type="button"
      role="tab"
      :aria-selected="model === f.value"
      class="px-14 py-6 rounded-8 text-[13px] font-medium transition-colors"
      :style="model === f.value
        ? 'background: var(--zip-surface); color: var(--zip-text); box-shadow: 0 1px 2px rgba(16,32,24,.06)'
        : 'color: var(--zip-text-muted)'"
      @click="model = f.value"
    >
      {{ f.label }}
    </button>
  </div>
</template>
