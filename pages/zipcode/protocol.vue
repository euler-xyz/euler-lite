<script setup lang="ts">
// Protocol-health dashboard (spec §10.8).
import { formatCompactUsdValue } from '~/utils/string-utils'

definePageMeta({ layout: 'zipcode' })
useHead({ title: 'Protocol · Zip Code Finance' })

const { protocolHealth } = useZipDemo()
const advancedOpen = ref(false)

const advanced = computed(() => {
  const h = protocolHealth.value
  return [
    { label: 'Outstanding loan value', value: formatCompactUsdValue(h.capitalDeployedUsd) },
    { label: 'Idle USDC reserve', value: formatCompactUsdValue(h.idleUsdcReserveUsd) },
    { label: 'Current redemption queue', value: formatCompactUsdValue(h.redemptionQueueUsd) },
    { label: 'Epoch utilization', value: '64%' },
  ]
})
</script>

<template>
  <div class="flex flex-col gap-24">
    <header class="max-w-[560px]">
      <h1 class="zip-display text-[34px]">
        Protocol health
      </h1>
      <p
        class="mt-12 text-[16px]"
        style="color: var(--zip-text-muted)"
      >
        A transparent view of the credit pool and its available liquidity.
      </p>
    </header>

    <ZipProtocolMetrics secondary />

    <div class="zip-card p-24">
      <div class="flex items-center justify-between mb-12">
        <h3 class="zip-display text-[18px]">
          Capital deployment
        </h3>
      </div>
      <ZipCapitalDeploymentBar
        :deployed-usd="protocolHealth.capitalDeployedUsd"
        :idle-usdc="protocolHealth.idleUsdcReserveUsd"
        show-legend
      />
    </div>

    <div class="zip-card-muted p-24 max-w-[720px]">
      <h3 class="zip-display text-[18px] mb-12">
        How the pool works
      </h3>
      <div
        class="flex flex-col gap-12 text-[15px]"
        style="color: var(--zip-text)"
      >
        <p>zipUSD is minted at a 1:1 ratio when USDC enters the Zip Code credit pool.</p>
        <p>The pool allocates capital to verified HELOC originators and keeps a reserve for redemptions.</p>
        <p>Redemptions settle through an epoch queue so that capital can be returned fairly when liquidity is limited.</p>
      </div>
    </div>

    <!-- Advanced accordion -->
    <div class="zip-card-flat p-24">
      <button
        type="button"
        class="flex items-center justify-between w-full"
        @click="advancedOpen = !advancedOpen"
      >
        <span class="text-[15px] font-medium">View technical details</span>
        <SvgIcon
          name="arrow-down"
          class="w-18 h-18 transition-transform"
          :style="advancedOpen ? 'transform: rotate(180deg)' : ''"
        />
      </button>
      <dl
        v-if="advancedOpen"
        class="grid grid-cols-2 gap-x-24 gap-y-12 mt-16 mobile:grid-cols-1"
      >
        <div
          v-for="m in advanced"
          :key="m.label"
          class="flex items-center justify-between text-[14px]"
        >
          <dt style="color: var(--zip-text-muted)">
            {{ m.label }}
          </dt>
          <dd class="font-medium tabular-nums">
            {{ m.value }}
          </dd>
        </div>
      </dl>
    </div>
  </div>
</template>
