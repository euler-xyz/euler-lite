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
      class="activity-filter-chip shrink-0"
      :class="{ 'activity-filter-chip--active': selected.length === 0 }"
      :aria-pressed="selected.length === 0"
      @click="selectAll"
    >
      All
    </button>
    <button
      v-for="option in options"
      :key="option.value"
      type="button"
      class="activity-filter-chip shrink-0"
      :class="{ 'activity-filter-chip--active': selected.includes(option.value) }"
      :aria-pressed="selected.includes(option.value)"
      @click="toggle(option.value)"
    >
      {{ option.count !== undefined ? `${option.label} (${option.count})` : option.label }}
    </button>
  </div>
</template>

<style scoped lang="scss">
/* Mirrors UiSelect's `.ui-select__chip` filter pills — those styles only load
   with a mounted UiSelect, so they are replicated here from the same theme
   variables to keep every filter control in the app looking identical. */
.activity-filter-chip {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 16px;
  font-size: 14px;
  font-weight: 400;
  background: var(--ui-select-chip-background-color);
  border: 1px solid var(--neutral-300);
  border-radius: 100px;
  cursor: pointer;
  white-space: nowrap;
  transition: all 0.15s ease;
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.04);

  &:hover {
    border-color: var(--neutral-400);
    background: var(--neutral-50);
    box-shadow: 0 2px 4px rgba(0, 0, 0, 0.06);
  }

  &--active {
    font-weight: 600;
    background: var(--ui-select-chip-active-background-color);
    color: var(--ui-select-chip-active-color);
    border-color: transparent;
    box-shadow: var(--accent-shadow-md);

    &:hover {
      background: var(--accent-600);
      border-color: transparent;
      box-shadow: var(--accent-shadow-lg);
    }
  }
}
</style>
