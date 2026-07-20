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
    <button
      type="button"
      class="h-32 shrink-0 rounded-full px-12 text-p3 transition-colors"
      :class="selected.length === 0 ? 'bg-accent-600 text-black hover:bg-accent-700' : 'bg-surface text-content-secondary hover:text-content-primary'"
      :aria-pressed="selected.length === 0"
      @click="selectAll"
    >
      All
    </button>
    <button
      v-for="option in options"
      :key="option.value"
      type="button"
      class="h-32 shrink-0 rounded-full px-12 text-p3 transition-colors"
      :class="selected.includes(option.value) ? 'bg-accent-600 text-black hover:bg-accent-700' : 'bg-surface text-content-secondary hover:text-content-primary'"
      :aria-pressed="selected.includes(option.value)"
      @click="toggle(option.value)"
    >
      {{ option.label }}
    </button>
  </div>
</template>
