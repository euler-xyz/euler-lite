<script setup lang="ts">
defineProps<{
  loading?: boolean
  variant?: 'card'
}>()
</script>

<template>
  <div
    class="relative p-16 rounded-16 flex flex-col gap-16 bg-surface-secondary shadow-card"
    style="overflow: hidden"
  >
    <BaseLoadingBar v-show="loading" />
    <slot />
  </div>
</template>
