<script setup lang="ts">
const props = withDefaults(defineProps<{
  category?: string
  compact?: boolean
  label?: string
  title?: string
}>(), {
  compact: false,
})
</script>

<template>
  <span
    class="inline-flex items-center rounded-8 border border-line-subtle bg-surface-secondary text-content-tertiary text-p5 whitespace-nowrap"
    :class="props.compact ? 'gap-4 px-7 py-2' : 'gap-5 px-9 py-3'"
    :title="props.title ?? (category ? `Assets share the ${category} price-correlation category.` : 'Assets share a price-correlation category.')"
  >
    <SvgIcon
      name="nodes"
      class="!w-13 !h-13 shrink-0 text-content-muted"
    />
    <span>{{ props.label ?? 'Correlated' }}</span>
  </span>
</template>
