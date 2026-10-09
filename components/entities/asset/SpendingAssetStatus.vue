<script setup lang="ts">
defineProps<{ loading?: boolean, error?: string | null }>()
defineEmits<{ retry: [] }>()
</script>

<template>
  <div
    v-if="loading || error"
    role="status"
    class="text-p3 text-content-secondary"
  >
    <span v-if="loading">Verifying token decimals…</span>
    <template v-else>
      {{ error }}
      <button
        type="button"
        class="underline ml-8"
        @click="$emit('retry')"
      >
        Retry
      </button>
    </template>
  </div>
</template>
