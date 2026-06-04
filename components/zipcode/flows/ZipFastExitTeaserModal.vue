<script setup lang="ts">
// Optional secondary-market fast-exit teaser (spec §10.7). Mocked — no
// execution. Feature-flagged via showFastExit.
import { formatZipUsd, formatCurrency, demoConfig } from '~/types/zipcode'

const emit = defineEmits<{ (e: 'close'): void }>()

const { activeRedemptionRequest } = useZipDemo()
const sellAmount = computed(() => activeRedemptionRequest.value.zipUsdRequested || demoConfig.defaultRedemptionZipUsd)
const proceeds = computed(() => sellAmount.value * demoConfig.secondaryMarketPriceUsd)
</script>

<template>
  <ZipModalShell
    title="Fast exit"
    @close="emit('close')"
  >
    <p class="text-[15px]">
      Sell zipUSD on the secondary market for immediate liquidity.
    </p>
    <div class="zip-card-muted p-16 mt-16 flex flex-col gap-10">
      <div class="flex items-center justify-between text-[14px]">
        <span style="color: var(--zip-text-muted)">Market price</span>
        <span class="font-semibold tabular-nums">{{ formatCurrency(demoConfig.secondaryMarketPriceUsd, { cents: true }) }}</span>
      </div>
      <div class="flex items-center justify-between text-[14px]">
        <span style="color: var(--zip-text-muted)">You sell</span>
        <span class="tabular-nums">{{ formatZipUsd(sellAmount) }}</span>
      </div>
      <div class="flex items-center justify-between text-[14px]">
        <span style="color: var(--zip-text-muted)">Estimated proceeds</span>
        <span class="font-semibold tabular-nums">{{ formatCurrency(proceeds) }}</span>
      </div>
    </div>
    <p
      class="text-[13px] mt-12"
      style="color: var(--zip-text-muted)"
    >
      Unlike queue redemption, the market price may be below the $1 reference value.
    </p>
    <div class="flex items-center gap-12 mt-20">
      <UiButton
        class="flex-1"
        disabled
      >
        Preview fast exit
      </UiButton>
      <UiButton
        variant="primary-stroke"
        @click="emit('close')"
      >
        Use queue instead
      </UiButton>
    </div>
  </ZipModalShell>
</template>
