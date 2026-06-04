<script setup lang="ts">
// Redemption entry (spec §10.4). Opens the redemption flow modal; also offers a
// graceful page state for deep links.
import { formatZipUsd } from '~/types/zipcode'

definePageMeta({ layout: 'zipcode' })
useHead({ title: 'Redeem · Zip Code Finance' })

const { position } = useZipDemo()
const { openRedemptionFlow } = useZipModals()

onMounted(() => {
  if (position.value.zipUsdBalance > 0) openRedemptionFlow()
})
</script>

<template>
  <div class="max-w-[520px]">
    <h1 class="zip-display text-[32px]">
      Redeem zipUSD
    </h1>
    <p
      class="mt-12 text-[16px]"
      style="color: var(--zip-text-muted)"
    >
      Request redemption of your zipUSD for USDC. Redemptions settle through a 30-day epoch queue.
    </p>

    <div class="zip-card p-24 mt-24">
      <p
        class="text-[13px]"
        style="color: var(--zip-text-muted)"
      >
        Available zipUSD
      </p>
      <p class="text-[28px] font-semibold tabular-nums">
        {{ formatZipUsd(position.zipUsdBalance) }}
      </p>
      <UiButton
        size="large"
        class="mt-16 w-full"
        :disabled="position.zipUsdBalance <= 0"
        @click="openRedemptionFlow"
      >
        Request redemption
      </UiButton>
      <p
        v-if="position.zipUsdBalance <= 0"
        class="mt-12 text-[13px]"
        style="color: var(--zip-text-muted)"
      >
        Deposit first to receive zipUSD you can redeem.
      </p>
    </div>
  </div>
</template>
