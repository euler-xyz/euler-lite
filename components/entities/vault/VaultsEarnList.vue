<script setup lang="ts">
import type { EarnVault } from '~/entities/vault'

defineProps<{ items: EarnVault[] }>()
</script>

<template>
  <div
    class="flex flex-col gap-8"
    data-id="vault-list"
    data-list="earn"
    :data-count="items.length"
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
