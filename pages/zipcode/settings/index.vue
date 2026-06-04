<script setup lang="ts">
// Profile & preferences (spec §10.10).
import { demoConfig } from '~/types/zipcode'

definePageMeta({ layout: 'zipcode' })
useHead({ title: 'Settings · Zip Code Finance' })

const { flags } = useZipFeatureFlags()
</script>

<template>
  <div class="max-w-[680px] flex flex-col gap-20">
    <h1 class="zip-display text-[32px]">
      Settings
    </h1>

    <section class="zip-card p-24">
      <h3 class="zip-eyebrow mb-12">
        Profile
      </h3>
      <p class="text-[16px] font-medium">
        {{ demoConfig.lenderName }}
      </p>
      <p
        class="text-[14px]"
        style="color: var(--zip-text-muted)"
      >
        {{ demoConfig.lenderEmail }}
      </p>
    </section>

    <section class="zip-card p-24">
      <h3 class="zip-eyebrow mb-12">
        Payment methods
      </h3>
      <div class="flex flex-col gap-10 text-[15px]">
        <div class="flex items-center justify-between">
          <span>Digital-dollar balance</span>
          <span class="zip-badge zip-badge--success"><span class="zip-badge__dot" />Primary</span>
        </div>
        <div class="flex items-center justify-between">
          <span>Connected wallet</span>
          <span
            class="text-[13px]"
            style="color: var(--zip-text-muted)"
          >Advanced</span>
        </div>
      </div>
    </section>

    <section class="zip-card p-24">
      <h3 class="zip-eyebrow mb-12">
        Documents
      </h3>
      <ul
        class="flex flex-col gap-8 text-[15px]"
        style="color: var(--zip-info)"
      >
        <li><a href="#">Pool terms</a></li>
        <li><a href="#">Risk disclosure</a></li>
        <li><a href="#">Redemption terms</a></li>
      </ul>
    </section>

    <section
      v-if="flags.showAdvancedSettings"
      class="zip-card-flat p-24 flex items-center justify-between"
    >
      <div>
        <h3 class="text-[15px] font-medium">
          Advanced settings
        </h3>
        <p
          class="text-[13px]"
          style="color: var(--zip-text-muted)"
        >
          Wallet, network and technical details
        </p>
      </div>
      <UiButton
        variant="primary-stroke"
        to="/zipcode/settings/advanced"
      >
        View advanced settings
      </UiButton>
    </section>
  </div>
</template>
