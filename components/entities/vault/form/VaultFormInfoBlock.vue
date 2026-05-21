<script setup lang="ts">
defineProps<{
  loading?: boolean
  variant?: 'card'
}>()
</script>

<template>
  <div
    class="relative p-16 rounded-16 flex flex-col gap-16 bg-surface-secondary shadow-card"
  >
    <div
      v-show="loading"
      class="absolute top-0 left-0 right-0 h-[3px] rounded-t-16 overflow-hidden"
    >
      <BaseLoadingBar />
    </div>
    <slot />
  </div>
</template>
