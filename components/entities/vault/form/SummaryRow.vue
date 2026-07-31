<script setup lang="ts">
defineProps<{
  label: string
  alignTop?: boolean
  dataKey?: string
  dataField?: string
  dataValue?: string | number | boolean | null
}>()
</script>

<template>
  <div
    class="flex justify-between flex-wrap gap-8"
    :class="alignTop ? 'items-start' : 'items-center'"
    data-id="data-point"
    :data-key="dataKey"
    :data-field="dataField || label"
    :data-value="dataValue"
  >
    <p class="text-content-tertiary shrink-0">
      <slot name="label">
        {{ label }}
      </slot>
    </p>
    <div class="ml-auto text-right">
      <slot />
    </div>
  </div>
</template>
