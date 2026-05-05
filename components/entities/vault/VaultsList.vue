<script setup lang="ts">
import type { EVault } from '~/entities/vault'

defineProps<{ items: EVault[], type: 'lend' | 'borrow' }>()
</script>

<template>
  <div
    class="flex flex-col gap-8"
  >
    <VaultItem
      v-for="(vault, index) in items"
      :key="vault.address"
      :vault="vault"
      :type="type"
      class="animate-fade-in-up"
      :style="{ animationDelay: `${Math.min(index * 0.03, 0.2)}s` }"
    />
  </div>
</template>
