<script setup lang="ts">
import type { ActivityFilterOption } from '~/utils/activity-display'

const selected = defineModel<string[]>({ required: true })
defineProps<{
  options: readonly ActivityFilterOption[]
}>()

const selectAll = () => {
  selected.value = []
}

const toggle = (filter: string) => {
  selected.value = selected.value.includes(filter)
    ? selected.value.filter(value => value !== filter)
    : [...selected.value, filter]
}
</script>

<template>
  <div
    class="flex max-w-full flex-wrap gap-8"
    role="group"
    aria-label="Activity categories"
  >
    <UiFilterChip
      class="shrink-0"
      :active="selected.length === 0"
      :aria-pressed="selected.length === 0"
      @click="selectAll"
    >
      All
    </UiFilterChip>
    <UiFilterChip
      v-for="option in options"
      :key="option.value"
      class="shrink-0"
      :active="selected.includes(option.value)"
      :aria-pressed="selected.includes(option.value)"
      @click="toggle(option.value)"
    >
      {{ option.count !== undefined ? `${option.label} (${option.count})` : option.label }}
    </UiFilterChip>
  </div>
</template>
