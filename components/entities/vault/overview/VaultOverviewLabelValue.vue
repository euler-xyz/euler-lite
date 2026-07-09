<script setup lang="ts">
const { label, value, orientation = 'vertical', dataList, dataKey, dataField, dataValue } = defineProps<{
  label?: string
  value?: string
  orientation?: 'horizontal' | 'vertical'
  dataList?: string
  dataKey?: string
  dataField?: string
  dataValue?: string | number | boolean | null
}>()
</script>

<template>
  <div
    class="flex gap-8"
    :class="[orientation === 'horizontal' ? 'flex-row justify-between items-center w-full min-w-0 gap-12' : 'flex flex-col']"
    data-id="data-point"
    :data-list="dataList"
    :data-key="dataKey"
    :data-field="dataField || label"
    :data-value="dataValue"
  >
    <div
      class="text-p3 text-content-tertiary min-w-0"
      :class="{ shrink: orientation === 'horizontal' }"
    >
      <slot name="label">
        {{ label }}
      </slot>
    </div>
    <div
      class="text-p2 text-content-primary"
      :class="{ 'text-right shrink-0': orientation === 'horizontal' }"
    >
      <slot>
        {{ value || '-' }}
      </slot>
    </div>
  </div>
</template>
