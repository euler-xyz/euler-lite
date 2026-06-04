<script setup lang="ts">
import type { RedemptionStatus } from '~/types/zipcode'

// Accessible status pill (spec §18: not colour-only — always carries a label).
const props = defineProps<{
  status: RedemptionStatus | 'pending' | 'complete'
  label?: string
}>()

const map: Record<string, { variant: string, label: string }> = {
  'queued': { variant: 'info', label: 'Pending settlement' },
  'partially-settled': { variant: 'warning', label: 'Partially settled' },
  'claimable': { variant: 'success', label: 'Claimable' },
  'claimed': { variant: 'neutral', label: 'Claimed' },
  'pending': { variant: 'warning', label: 'Pending' },
  'complete': { variant: 'success', label: 'Complete' },
}

const resolved = computed(() => map[props.status] ?? { variant: 'neutral', label: props.status })
</script>

<template>
  <span
    class="zip-badge"
    :class="`zip-badge--${resolved.variant}`"
  >
    <span class="zip-badge__dot" />
    {{ label ?? resolved.label }}
  </span>
</template>
