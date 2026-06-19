<script setup lang="ts">
import { computed } from 'vue'
import type { BatchEntry } from '~/composables/useTxBatch'

// Shared operation label ("Deposit USDC", "Multiply cbBTC/USDC", …) for batch
// rows. Single source of the verb/symbol/multiply derivation so the builder and
// the review modal render the operation identically.
const props = defineProps<{ entry: BatchEntry }>()

const OP_VERB: Record<string, string> = {
  'supply': 'Deposit',
  'withdraw': 'Withdraw',
  'borrow': 'Borrow',
  'repay': 'Repay',
  'swap': 'Swap',
  'swap-supply': 'Deposit',
  'swap-withdraw': 'Withdraw',
  'swap-borrow': 'Swap',
  'transfer': 'Transfer',
  'reward': 'Claim',
  'brevis-reward': 'Claim',
  'fuul-reward': 'Claim',
  'reul-unlock': 'Unlock',
  'disableCollateral': 'Disable collateral',
}

const label = computed(() => {
  // Verbatim override (e.g. "Refinance USDC/wstETH") wins over the derived
  // verb+symbol, so refinance rows name the position rather than the swap leg.
  if (props.entry.nameOverride) {
    return { verb: undefined, symbol: undefined, fallback: props.entry.nameOverride }
  }
  const review = props.entry.review as { type?: string, asset?: { symbol?: string }, swapToAsset?: { symbol?: string } } | undefined
  const longSym = review?.swapToAsset?.symbol
  const shortSym = review?.asset?.symbol
  const isMultiply = props.entry.multiply === true
  const verb = isMultiply ? 'Multiply' : (review?.type ? OP_VERB[review.type] : undefined)
  // Multiply shows the long/short pair; same-asset multiply collapses to one symbol.
  const symbol = isMultiply
    ? (longSym && shortSym && longSym !== shortSym ? `${longSym}/${shortSym}` : (longSym || shortSym))
    : review?.type === 'swap-supply'
      ? (longSym || shortSym)
      : shortSym
  return { verb, symbol, fallback: props.entry.label }
})
</script>

<template>
  <span class="truncate text-p2 text-content-primary">
    <template v-if="label.verb">
      {{ label.verb }}
      <span v-if="label.symbol">{{ label.symbol }}</span>
    </template>
    <template v-else>{{ label.fallback }}</template>
  </span>
</template>
