<script setup lang="ts">
// Redemption status (spec §10.5) — queued / partial / claimable / claimed.
definePageMeta({ layout: 'zipcode' })
useHead({ title: 'Redemption status · Zip Code Finance' })

const { flags } = useZipFeatureFlags()
const { openClaimFlow, openFastExitTeaser } = useZipModals()
</script>

<template>
  <div class="max-w-[560px]">
    <h1 class="zip-display text-[32px] mb-20">
      Redemption status
    </h1>
    <ZipRedemptionStatusCard
      :show-fast-exit="flags.showFastExit"
      @claim="openClaimFlow"
      @fast-exit="openFastExitTeaser"
    />
    <div class="flex items-center gap-12 mt-16">
      <UiButton
        variant="primary-stroke"
        to="/zipcode/portfolio"
      >
        Back to portfolio
      </UiButton>
    </div>
  </div>
</template>
