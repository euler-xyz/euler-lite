<script setup lang="ts">
const props = withDefaults(defineProps<{
  compact?: boolean
  label?: string
  title?: string
}>(), {
  compact: false,
  label: 'Correlated',
  title: 'Assets share a trusted price-correlation category.',
})
</script>

<template>
  <span
    class="correlated-pair-badge inline-flex items-center rounded-8 whitespace-nowrap"
    :class="props.compact ? 'px-6 py-1' : 'px-8 py-2'"
    :title="props.title"
  >
    {{ props.label }}
  </span>
</template>

<style scoped lang="scss">
.correlated-pair-badge {
  border: 1px solid rgba(136, 166, 204, 0.3);
  background-color: rgba(136, 166, 204, 0.1);
  color: #88a6cc;
  font-size: 12px;
  font-weight: 400;
  line-height: 16px;
}
</style>
