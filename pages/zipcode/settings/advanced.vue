<script setup lang="ts">
// Advanced / technical details (spec §10.11). Visually secondary.
import { demoConfig } from '~/types/zipcode'

definePageMeta({ layout: 'zipcode' })
useHead({ title: 'Advanced settings · Zip Code Finance' })

const rows = [
  { label: 'Wallet', value: demoConfig.walletAddress },
  { label: 'Settlement asset', value: 'USDC' },
  { label: 'Credit-dollar asset', value: 'zipUSD' },
  { label: 'Network', value: demoConfig.network },
  { label: 'Pool', value: 'EulerEarn-backed credit pool' },
]
</script>

<template>
  <div class="max-w-[560px]">
    <NuxtLink
      to="/zipcode/settings"
      class="text-[13px]"
      style="color: var(--zip-text-muted)"
    >← Settings</NuxtLink>
    <h1 class="zip-display text-[28px] mt-8 mb-20">
      Advanced settings
    </h1>

    <div class="zip-card-flat p-24">
      <dl class="flex flex-col gap-14">
        <div
          v-for="row in rows"
          :key="row.label"
          class="flex items-center justify-between text-[14px]"
        >
          <dt style="color: var(--zip-text-muted)">
            {{ row.label }}
          </dt>
          <dd class="font-medium tabular-nums">
            {{ row.value }}
          </dd>
        </div>
      </dl>
      <UiButton
        variant="primary-stroke"
        class="mt-20"
        to="/zipcode/activity"
      >
        View on-chain activity
      </UiButton>
    </div>
  </div>
</template>
