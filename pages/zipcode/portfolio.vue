<script setup lang="ts">
// Lender portfolio (spec §10.3).
import { formatCompactUsdValue, formatUsdValue } from '~/utils/string-utils'

definePageMeta({ layout: 'zipcode' })
useHead({ title: 'Portfolio · Zip Code Finance' })

const { protocolHealth, activity, hasRedemptionRequest } = useZipDemo()
const { flags } = useZipFeatureFlags()
const { openDepositFlow, openRedemptionFlow, openClaimFlow, openFastExitTeaser } = useZipModals()

const recentActivity = computed(() => activity.value.slice(0, 4))

const protocolSummary = computed(() => {
  const h = protocolHealth.value
  return [
    { label: 'Total protocol NAV', value: formatCompactUsdValue(h.totalNavUsd) },
    { label: 'zipUSD minted', value: formatCompactUsdValue(h.zipUsdMinted) },
    { label: 'zipUSD reference price', value: formatUsdValue(h.zipUsdMarketPriceUsd) },
    { label: 'Available liquidity', value: formatCompactUsdValue(h.availableLiquidityUsd) },
  ]
})
</script>

<template>
  <div class="flex flex-col gap-24">
    <ZipPortfolioSummary
      @deposit="openDepositFlow"
      @redeem="openRedemptionFlow"
    />

    <div class="grid grid-cols-2 gap-24 mobile:grid-cols-1">
      <ZipUsdBalanceCard @redeem="openRedemptionFlow" />

      <!-- Protocol summary card -->
      <div class="zip-card p-24 flex flex-col">
        <h3 class="zip-display text-[20px] mb-16">
          Protocol health
        </h3>
        <dl class="flex flex-col gap-12">
          <div
            v-for="m in protocolSummary"
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
        <UiButton
          v-if="flags.showProtocolHealthPage"
          variant="primary-stroke"
          class="mt-auto self-start !mt-16"
          to="/zipcode/protocol"
        >
          View protocol
        </UiButton>
      </div>
    </div>

    <ZipRedemptionStatusCard
      v-if="hasRedemptionRequest"
      :show-fast-exit="flags.showFastExit"
      @claim="openClaimFlow"
      @fast-exit="openFastExitTeaser"
    />

    <!-- Recent activity -->
    <div>
      <div class="flex items-center justify-between mb-12">
        <h3 class="zip-display text-[20px]">
          Recent activity
        </h3>
        <NuxtLink
          to="/zipcode/activity"
          class="text-[14px]"
          style="color: var(--zip-info)"
        >
          View all
        </NuxtLink>
      </div>
      <ZipActivityList :items="recentActivity" />
    </div>
  </div>
</template>
