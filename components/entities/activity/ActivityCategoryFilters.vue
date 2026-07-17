<script setup lang="ts">
import type { ActivityFilterOption } from '~/utils/activity-display'

const selected = defineModel<string[]>({ required: true })
const props = defineProps<{
  options: readonly ActivityFilterOption[]
}>()

const selectOptions = computed(() => props.options.map(option => ({
  label: option.label,
  value: option.value,
})))
</script>

<template>
  <UiSelect
    v-model="selected"
    class="w-fit max-w-full"
    :options="selectOptions"
    placeholder="All activity"
    title="Activity categories"
    show-selected-options
  />
</template>
