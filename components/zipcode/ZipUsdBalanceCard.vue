<script setup lang="ts">
import { formatCurrency, formatZipUsd } from '~/types/zipcode'

// Primary position card (spec §10.3). Emits `redeem` for the page to handle.
defineEmits<{ (e: 'redeem'): void }>()

const { position } = useZipDemo()
// TODO: szipUSD staking entrypoint — hidden while featureFlags.showSzipUsd is false (spec §20).
</script>

<template>
  <div class="zip-card p-24">
    <p
      class="text-[13px]"
      style="color: var(--zip-text-muted)"
    >
      Your position
    </p>
    <div class="flex items-center gap-10 mt-12">
      <span
        class="grid place-items-center w-36 h-36 rounded-12 text-[14px] font-semibold"
        style="background: var(--zip-brand-soft); color: #1f7a45"
      >z</span>
      <div>
        <p class="text-[15px] font-semibold">
          zipUSD
        </p>
        <p
          class="text-[13px]"
          style="color: var(--zip-text-muted)"
        >
          Senior $1 credit-dollar position
        </p>
      </div>
    </div>

    <div class="mt-20">
      <p class="text-[28px] font-semibold tabular-nums">
        {{ formatZipUsd(position.zipUsdBalance) }}
      </p>
      <p
        class="text-[15px] mt-2"
        style="color: var(--zip-text-muted)"
      >
        {{ formatCurrency(position.zipUsdBalance) }} · $1.00 reference
      </p>
    </div>

    <UiButton
      class="mt-20 w-full"
      :disabled="position.zipUsdBalance <= 0"
      @click="$emit('redeem')"
    >
      Request redemption
    </UiButton>
  </div>
</template>
