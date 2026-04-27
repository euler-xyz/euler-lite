<script setup lang="ts">
import { isPriceImpactWarning, isSlippageWarning } from '~/utils/priceImpact'
import { formatNumber } from '~/utils/string-utils'

const props = defineProps<{
  inputDisplay: string | null
  outputDisplay: string | null
  priceImpact: number | null
  slippage: number
  quoteSlippage?: number | null
  routedVia: string | null
  multipliedPriceImpact?: number | null
}>()

const emit = defineEmits<{
  (e: 'openSlippageSettings'): void
}>()

const SLIPPAGE_DIFF_TOLERANCE = 0.005

const slippageDiffers = computed(() =>
  props.quoteSlippage !== null
  && props.quoteSlippage !== undefined
  && Math.abs(props.quoteSlippage - props.slippage) >= SLIPPAGE_DIFF_TOLERANCE,
)

const quoteSlippageLabel = computed(() =>
  props.quoteSlippage !== null && props.quoteSlippage !== undefined
    ? formatNumber(props.quoteSlippage, 2, 0)
    : '',
)
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
    <div class="flex flex-col items-end gap-2">
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
      <span
        v-if="slippageDiffers"
        class="text-p4 text-warning-500 text-right"
      >
        Quote applies {{ quoteSlippageLabel }}% slippage
      </span>
    </div>
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
