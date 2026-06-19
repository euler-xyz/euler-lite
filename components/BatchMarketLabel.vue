<script setup lang="ts">
// Shared muted "market" (Euler label product) line used by both the batch
// builder rows and the review modal's roll-down details. Renders nothing when
// the market is unknown (vault not in a labelled product / not yet simulated).
defineProps<{ market?: string }>()
</script>

<template>
  <span
    v-if="market"
    class="block w-full truncate text-p3 text-content-tertiary"
  >{{ market }}</span>
</template>
