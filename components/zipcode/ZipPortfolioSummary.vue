<script setup lang="ts">
import { formatCurrency, formatZipUsd, demoConfig } from '~/types/zipcode'

// Portfolio header summary (spec §10.3). Dollars first, asset units second.
defineEmits<{ (e: 'deposit' | 'redeem'): void }>()

const { position } = useZipDemo()

const greeting = computed(() => {
  const first = demoConfig.lenderName.split(' ')[0]
  return `Good afternoon, ${first}`
})
</script>

<template>
  <div class="flex flex-wrap items-end justify-between gap-24">
    <div>
      <p class="zip-display text-[24px] mb-16">
        {{ greeting }}
      </p>
      <p
        class="text-[13px]"
        style="color: var(--zip-text-muted)"
      >
        Portfolio value
      </p>
      <p
        class="text-[44px] font-semibold tabular-nums leading-tight"
        style="color: var(--zip-text)"
      >
        {{ formatCurrency(position.portfolioValueUsd) }}
      </p>
      <div
        class="flex items-center gap-16 mt-8 text-[14px]"
        style="color: var(--zip-text-muted)"
      >
        <span>{{ formatZipUsd(position.zipUsdBalance) }}</span>
        <span
          class="zip-divider w-1 h-14"
          style="width:1px"
        />
        <span>Reference value $1.00</span>
      </div>
    </div>
    <div class="flex items-center gap-12">
      <UiButton
        variant="primary-stroke"
        @click="$emit('deposit')"
      >
        Deposit more
      </UiButton>
      <UiButton @click="$emit('redeem')">
        Request redemption
      </UiButton>
    </div>
  </div>
</template>
