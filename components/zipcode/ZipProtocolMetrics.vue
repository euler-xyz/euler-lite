<script setup lang="ts">
import { formatCompactUsdValue, formatUsdValue } from '~/utils/string-utils'
import { navToZipUsdMintedRatio } from '~/types/zipcode'

// Protocol-health metric grid (spec §10.8). `secondary` toggles the secondary
// metric set (NAV/minted ratio, redemption queue, idle reserve).
withDefaults(defineProps<{ secondary?: boolean }>(), { secondary: false })

const { protocolHealth } = useZipDemo()

const primary = computed(() => {
  const h = protocolHealth.value
  return [
    { label: 'Total protocol NAV', value: formatCompactUsdValue(h.totalNavUsd), emphasis: true },
    { label: 'zipUSD minted', value: formatCompactUsdValue(h.zipUsdMinted), emphasis: true },
    { label: 'zipUSD price', value: formatUsdValue(h.zipUsdMarketPriceUsd), emphasis: true },
    { label: 'Available liquidity', value: formatCompactUsdValue(h.availableLiquidityUsd), emphasis: true },
    { label: 'Capital deployed', value: formatCompactUsdValue(h.capitalDeployedUsd), emphasis: true },
  ]
})

const secondaryMetrics = computed(() => {
  const h = protocolHealth.value
  return [
    { label: 'NAV / zipUSD minted', value: `${navToZipUsdMintedRatio.toFixed(2)}x` },
    { label: 'Current redemption queue', value: formatCompactUsdValue(h.redemptionQueueUsd) },
    { label: 'Idle USDC reserve', value: formatCompactUsdValue(h.idleUsdcReserveUsd) },
  ]
})
</script>

<template>
  <div>
    <div class="grid grid-cols-3 gap-16 tablet:grid-cols-5 mobile:grid-cols-2">
      <ZipMetricCard
        v-for="m in primary"
        :key="m.label"
        :label="m.label"
        :value="m.value"
        emphasis
      />
    </div>

    <template v-if="secondary">
      <p class="zip-eyebrow mt-32 mb-12">
        Secondary metrics
      </p>
      <div class="grid grid-cols-3 gap-16 mobile:grid-cols-1">
        <ZipMetricCard
          v-for="m in secondaryMetrics"
          :key="m.label"
          :label="m.label"
          :value="m.value"
        />
      </div>
    </template>
  </div>
</template>
