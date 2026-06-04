<script setup lang="ts">
import { formatCompactUsdValue } from '~/utils/string-utils'

// Thin segmented bar: deployed vs idle reserve (spec §10.1, §10.8).
const props = defineProps<{
  deployedUsd: number
  idleUsdc: number
  showLegend?: boolean
}>()

const total = computed(() => props.deployedUsd + props.idleUsdc)
const deployedPct = computed(() =>
  total.value > 0 ? Math.round((props.deployedUsd / total.value) * 100) : 0,
)
</script>

<template>
  <div>
    <div class="zip-bar">
      <div
        class="zip-bar__fill"
        :style="{ width: `${deployedPct}%` }"
      />
    </div>
    <div
      v-if="showLegend"
      class="flex items-center justify-between mt-8 text-[13px]"
      style="color: var(--zip-text-muted)"
    >
      <span>{{ deployedPct }}% deployed · {{ formatCompactUsdValue(deployedUsd) }}</span>
      <span>{{ formatCompactUsdValue(idleUsdc) }} reserve</span>
    </div>
  </div>
</template>
