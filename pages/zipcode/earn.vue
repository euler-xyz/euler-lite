<script setup lang="ts">
// Earn landing — product story + entry into the deposit flow (spec §10.1).
definePageMeta({ layout: 'zipcode' })
useHead({ title: 'Earn · Zip Code Finance' })

const { openDepositFlow } = useZipModals()
const { flags } = useZipFeatureFlags()

const howItWorks = ref<HTMLElement>()
const scrollToHow = () => howItWorks.value?.scrollIntoView({ behavior: 'smooth', block: 'start' })
</script>

<template>
  <div>
    <!-- Hero -->
    <section class="max-w-[640px]">
      <p class="zip-eyebrow mb-12">
        ZIP CODE FINANCE
      </p>
      <h1 class="zip-display text-[48px] mobile:text-[34px] leading-[1.05]">
        Real-estate credit, made liquid
      </h1>
      <p
        class="mt-16 text-[17px]"
        style="color: var(--zip-text-muted)"
      >
        Deposit digital dollars into a verified HELOC credit pool and receive zipUSD at a 1:1 ratio.
      </p>
      <div class="flex items-center gap-12 mt-24">
        <UiButton
          size="large"
          @click="openDepositFlow"
        >
          Deposit funds
        </UiButton>
        <UiButton
          variant="primary-stroke"
          size="large"
          @click="scrollToHow"
        >
          See how it works
        </UiButton>
      </div>
    </section>

    <!-- Pool + institutional -->
    <section class="grid grid-cols-[1.6fr_1fr] gap-24 mt-40 tablet:grid-cols-[1.6fr_1fr] mobile:grid-cols-1">
      <ZipPoolCard @deposit="openDepositFlow" />
      <ZipInstitutionalTeaser v-if="flags.showInstitutionalTeaser" />
    </section>

    <!-- How it works + trust -->
    <section
      ref="howItWorks"
      class="grid grid-cols-2 gap-24 mt-24 mobile:grid-cols-1 scroll-mt-80"
    >
      <ZipHowItWorks />
      <ZipTrustPanel />
    </section>
  </div>
</template>
