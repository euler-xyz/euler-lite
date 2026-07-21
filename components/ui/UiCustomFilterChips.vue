<script setup lang="ts">
import type { CustomFilter } from '~/composables/useCustomFilters'

defineProps<{
  filters: readonly CustomFilter[]
  chipClass?: string
}>()

const emit = defineEmits<{
  remove: [id: string]
  add: []
}>()
</script>

<template>
  <UiFilterChip
    v-for="filter in filters"
    :key="filter.id"
    :class="chipClass"
    :active="filter.tone !== 'neutral'"
    @click="emit('remove', filter.id)"
  >
    {{ filter.label }}
    <UiIcon
      name="close"
      class="ui-filter-chip__icon"
    />
  </UiFilterChip>
  <button
    class="flex items-center gap-6 shrink-0 min-h-36 py-6 px-16 bg-surface border border-dashed border-line-default rounded-[100px] cursor-pointer hover:border-line-emphasis hover:bg-surface-secondary transition-all text-content-tertiary text-[14px]"
    data-id="custom-filter-trigger"
    @click="emit('add')"
  >
    <UiIcon
      name="plus"
      class="!w-14 !h-14"
    />
    Add filter
  </button>
</template>
