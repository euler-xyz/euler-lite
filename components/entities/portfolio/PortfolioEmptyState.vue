<script setup lang="ts">
const props = withDefaults(defineProps<{
  active: boolean
  activeText: string
  inactiveText: string
  icon?: string
}>(), {
  icon: 'search',
})

const text = computed(() => props.active ? props.activeText : props.inactiveText)
</script>

<template>
  <div class="flex flex-col gap-12 items-center text-neutral-500 text-center py-32">
    <UiEmptyStateIcon :name="icon" />
    <span>{{ text }}</span>
  </div>
</template>
