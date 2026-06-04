<script setup lang="ts">
// Claim entry (spec §10.6). Opens the claim flow when funds are claimable.
import { formatUsdc } from '~/types/zipcode'

definePageMeta({ layout: 'zipcode' })
useHead({ title: 'Claim · Zip Code Finance' })

const { activeRedemptionRequest, hasRedemptionRequest } = useZipDemo()
const { openClaimFlow } = useZipModals()

const claimable = computed(() => activeRedemptionRequest.value.usdcClaimable)

onMounted(() => {
  if (claimable.value > 0) openClaimFlow()
})
</script>

<template>
  <div class="max-w-[520px]">
    <h1 class="zip-display text-[32px]">
      Claim digital dollars
    </h1>
    <div class="zip-card p-24 mt-24">
      <p
        class="text-[13px]"
        style="color: var(--zip-text-muted)"
      >
        Available to claim
      </p>
      <p class="text-[28px] font-semibold tabular-nums">
        {{ formatUsdc(claimable) }}
      </p>
      <UiButton
        size="large"
        class="mt-16 w-full"
        :disabled="claimable <= 0"
        @click="openClaimFlow"
      >
        Confirm claim
      </UiButton>
      <p
        v-if="!hasRedemptionRequest || claimable <= 0"
        class="mt-12 text-[13px]"
        style="color: var(--zip-text-muted)"
      >
        Nothing to claim yet. Claimable USDC appears here once your redemption settles.
      </p>
    </div>
  </div>
</template>
