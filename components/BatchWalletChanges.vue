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
        class="batch-wallet-changes__row text-p3"
      >
        <span class="batch-wallet-changes__symbol text-content-secondary">{{ change.symbol || 'Token' }}</span>
        <span class="batch-wallet-changes__value">
          <span
            class="batch-wallet-changes__amount tabular-nums"
            :class="change.delta < 0n ? 'text-error-300' : 'text-accent-500'"
          >
            {{ formatAmount(change) }}
          </span>
          <span
            v-if="formatUsd(change)"
            class="batch-wallet-changes__usd tabular-nums text-p4 text-content-tertiary"
          >
            ({{ formatUsd(change) }})
          </span>
        </span>
      </li>
    </ul>
  </div>
</template>

<style scoped lang="scss">
.batch-wallet-changes {
  &__row {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 8px;
  }

  &__symbol {
    flex: 0 0 auto;
    max-width: 42%;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  &__value {
    display: flex;
    min-width: 0;
    flex: 1 1 0;
    flex-wrap: wrap;
    align-items: baseline;
    justify-content: flex-end;
    column-gap: 6px;
    row-gap: 1px;
    text-align: right;
  }

  &__amount,
  &__usd {
    max-width: 100%;
    overflow-wrap: anywhere;
  }
}
</style>
