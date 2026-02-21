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
  <div
    v-for="filter in filters"
    :key="filter.id"
    class="ui-select__chip ui-select__chip--active"
    :class="chipClass"
    @click="emit('remove', filter.id)"
  >
    {{ filter.label }}
    <UiIcon
      name="close"
      class="ui-select__chip-icon"
    />
  </div>
  <button
    class="flex items-center gap-6 shrink-0 min-h-36 py-6 px-12 bg-transparent border border-line-default rounded-none cursor-pointer hover:border-line-emphasis hover:bg-surface-secondary transition-all text-content-secondary text-[14px]"
    @click="emit('add')"
  >
    <UiIcon
      name="plus"
      class="!w-14 !h-14"
    />
    Filter
  </button>
</template>
