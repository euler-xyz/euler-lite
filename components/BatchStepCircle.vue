<script setup lang="ts">
// Shared numbered step circle for batch operation rows (builder + review modal).
// Filled with the accent tint; turns into a red warning marker when the op
// would revert. Reused so both surfaces look identical.
defineProps<{ index: number, failed?: boolean }>()
</script>

<template>
  <span
    class="inline-flex items-center justify-center w-22 h-22 rounded-full text-p3 border shrink-0"
    :class="failed
      ? 'bg-error-100 border-error-500 text-error-500'
      : 'bg-accent-100 border-accent-600 text-accent-500'"
  >
    <SvgIcon
      v-if="failed"
      name="warning"
      class="!w-12 !h-12"
    />
    <template v-else>{{ index }}</template>
  </span>
</template>
