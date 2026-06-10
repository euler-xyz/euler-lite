<script setup lang="ts">
import { ref, watch } from 'vue'
import { formatUnits } from 'viem'
import type { BatchWalletChange } from '~/composables/useTxBatch'
import { formatSmartAmount, formatUsdValue } from '~/utils/string-utils'
import { getTokenUsdPrice } from '~/utils/sdk-prices'
import { nanoToValue } from '~/utils/crypto-utils'

// Shared "Wallet changes" card (batch drawer + batch review modal): the
// batch's net wallet effect per token, with a USD estimate from the SDK
// price service. Tokens without a price just show the token amount.
const { changes } = defineProps<{ changes: BatchWalletChange[] }>()

// Key presence = lookup attempted (undefined = no price), so unpriced tokens
// aren't re-fetched every time the change list updates.
const usdPriceByToken = ref<Record<string, number | undefined>>({})

watch(
  () => changes.map(change => change.token),
  async (tokens) => {
    const missing = tokens.filter(token => !(token in usdPriceByToken.value))
    await Promise.all(missing.map(async (token) => {
      let price: number | undefined
      try {
        price = await getTokenUsdPrice(token)
      }
      catch {
        // No price for this token — the row falls back to the amount alone.
      }
      usdPriceByToken.value = { ...usdPriceByToken.value, [token]: price }
    }))
  },
  { immediate: true },
)

const formatAmount = (change: BatchWalletChange) => {
  const negative = change.delta < 0n
  const abs = negative ? -change.delta : change.delta
  const amount = formatSmartAmount(formatUnits(abs, change.decimals))
  return `${negative ? '−' : '+'}${amount}`
}

const formatUsd = (change: BatchWalletChange): string | undefined => {
  const price = usdPriceByToken.value[change.token]
  if (price === undefined) return undefined
  const abs = change.delta < 0n ? -change.delta : change.delta
  return formatUsdValue(nanoToValue(abs, change.decimals) * price)
}
</script>

<template>
  <div class="bg-surface-elevated rounded-12 px-12 py-10">
    <p class="text-p3 text-content-tertiary mb-6">
      Wallet changes
    </p>
    <ul class="flex flex-col gap-4">
      <li
        v-for="change in changes"
        :key="change.token"
        class="flex items-start justify-between text-p3"
      >
        <span class="text-content-secondary">{{ change.symbol || 'Token' }}</span>
        <span class="flex flex-col items-end">
          <span
            class="tabular-nums"
            :class="change.delta < 0n ? 'text-error-300' : 'text-accent-500'"
          >
            {{ formatAmount(change) }}
          </span>
          <span
            v-if="formatUsd(change)"
            class="tabular-nums text-p4 text-content-tertiary"
          >
            {{ formatUsd(change) }}
          </span>
        </span>
      </li>
    </ul>
  </div>
</template>
