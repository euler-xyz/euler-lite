<script setup lang="ts">
import type { VaultWarning } from '~/composables/useVaultWarnings'

const { warnings } = defineProps<{
  warnings: (VaultWarning | null)[]
}>()

const activeWarnings = computed(() => warnings.filter((w): w is VaultWarning => w !== null))
</script>

<template>
  <div
    v-if="activeWarnings.length"
    class="flex flex-col gap-12"
  >
    <UiToast
      v-for="warning in activeWarnings"
      :key="warning.title"
      :title="warning.title"
      :description="warning.message"
      :variant="warning.level === 'critical' ? 'error' : warning.level === 'info' ? 'info' : 'warning'"
      size="compact"
    />
  </div>
</template>
