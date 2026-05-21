<script setup lang="ts">
import type { VaultWarning } from '~/composables/useVaultWarnings'

const { warnings } = defineProps<{
  warnings: (VaultWarning | null)[]
}>()

const activeWarnings = computed(() => warnings.filter((w): w is VaultWarning => w !== null))

const getWarningVariant = (warning: VaultWarning) => {
  if (warning.level === 'critical') return 'error'
  if (warning.tone === 'success') return 'success'
  if (warning.level === 'info') return 'info'
  return 'warning'
}
</script>

<template>
  <div
    v-if="activeWarnings.length"
    class="flex flex-col gap-12"
  >
    <UiAlert
      v-for="warning in activeWarnings"
      :key="warning.title"
      :title="warning.title"
      :description="warning.message"
      :variant="getWarningVariant(warning)"
      size="compact"
    />
  </div>
</template>
