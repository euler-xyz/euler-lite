<script setup lang="ts">
import type { EulerEarn } from '~/entities/vault'

defineProps<{ items: EulerEarn[] }>()
</script>

<template>
  <div
    class="flex flex-col gap-8"
  >
    <VaultEarnItem
      v-for="(vault, index) in items"
      :key="vault.address"
      :vault="vault"
      class="animate-fade-in-up"
      :style="{ animationDelay: `${Math.min(index * 0.03, 0.2)}s` }"
    />
  </div>
</template>
