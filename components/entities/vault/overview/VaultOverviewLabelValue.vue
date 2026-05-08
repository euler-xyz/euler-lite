<script setup lang="ts">
const { label, value, orientation = 'vertical', dataKey, dataField, dataValue } = defineProps<{
  label?: string
  value?: string
  orientation?: 'horizontal' | 'vertical'
  dataKey?: string
  dataField?: string
  dataValue?: string | number | boolean | null
}>()
</script>

<template>
  <div
    class="flex gap-8"
    :class="[orientation === 'horizontal' ? 'flex-row justify-between w-full' : 'flex flex-col']"
    data-id="data-point"
    :data-key="dataKey"
    :data-field="dataField || label"
    :data-value="dataValue"
  >
    <div class="text-p3 text-content-tertiary">
      <slot name="label">
        {{ label }}
      </slot>
    </div>
    <div class="text-p2 text-content-primary">
      <slot>
        {{ value || '-' }}
      </slot>
    </div>
  </div>
</template>
