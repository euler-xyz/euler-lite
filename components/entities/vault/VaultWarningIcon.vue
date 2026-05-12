<script setup lang="ts">
import type { AlignedPlacement } from '@floating-ui/vue'
import type { VaultWarning, WarningLevel } from '~/composables/useVaultWarnings'

const { warning, tooltipPlacement = 'top-end' } = defineProps<{
  warning: VaultWarning | (VaultWarning | null)[] | null
  tooltipPlacement?: AlignedPlacement
}>()

const warnings = computed<VaultWarning[]>(() => {
  if (!warning) return []
  return (Array.isArray(warning) ? warning : [warning]).filter((w): w is VaultWarning => w !== null)
})

const LEVEL_RANK: Record<WarningLevel, number> = { info: 0, high: 1, critical: 2 }

const highestLevel = computed<WarningLevel | null>(() => {
  if (warnings.value.length === 0) return null
  return warnings.value.reduce<WarningLevel>(
    (acc, w) => (LEVEL_RANK[w.level] > LEVEL_RANK[acc] ? w.level : acc),
    'info',
  )
})

const sections = computed(() =>
  warnings.value.map(w => ({ title: w.title, text: w.message })),
)
</script>

<template>
  <UiFootnote
    v-if="highestLevel"
    :icon="highestLevel === 'info' ? 'info-circle' : 'warning'"
    :sections="sections"
    :tooltip-placement="tooltipPlacement"
    :class="highestLevel === 'critical'
      ? '[--ui-footnote-icon-color:var(--error-500)]'
      : '[--ui-footnote-icon-color:var(--warning-500)]'"
  />
</template>
