<script setup lang="ts">
import { isPriceImpactWarning, isSlippageWarning } from '~/utils/priceImpact'
import { formatNumber } from '~/utils/string-utils'

defineProps<{
  inputDisplay: string | null
  outputDisplay: string | null
  priceImpact: number | null
  slippage: number
  routedVia: string | null
  multipliedPriceImpact?: number | null
}>()

const emit = defineEmits<{
  (e: 'openSlippageSettings'): void
}>()
</script>

<template>
  <SummaryRow
    v-if="inputDisplay"
    label="Swap in"
  >
    <p class="text-p2 text-right">
      {{ inputDisplay }}
    </p>
  </SummaryRow>
  <SummaryRow
    v-if="outputDisplay"
    label="Swap out"
  >
    <p class="text-p2 text-right">
      {{ outputDisplay }}
    </p>
  </SummaryRow>
  <SummaryRow
    v-if="priceImpact !== null"
    label="Price impact"
  >
    <p
      class="text-p2"
      :class="{ 'text-error-500': isPriceImpactWarning(priceImpact) }"
    >
      {{ formatNumber(priceImpact, 2, 2) }}%
    </p>
  </SummaryRow>
  <SummaryRow
    v-if="multipliedPriceImpact !== null && multipliedPriceImpact !== undefined"
    label="Multiplied price impact"
  >
    <p
      class="text-p2"
      :class="{ 'text-error-500': isPriceImpactWarning(multipliedPriceImpact) }"
    >
      {{ formatNumber(multipliedPriceImpact, 2, 2) }}%
    </p>
  </SummaryRow>
  <SummaryRow label="Slippage tolerance">
    <button
      type="button"
      class="flex items-center gap-6 text-p2"
      @click="emit('openSlippageSettings')"
    >
      <span :class="{ 'text-error-500': isSlippageWarning(slippage) }">{{ formatNumber(slippage, 2, 0) }}%</span>
      <SvgIcon
        name="edit"
        class="!w-16 !h-16 text-accent-600"
      />
    </button>
  </SummaryRow>
  <SummaryRow
    v-if="routedVia"
    label="Routed via"
  >
    <p class="text-p2 text-right">
      {{ routedVia }}
    </p>
  </SummaryRow>
</template>
