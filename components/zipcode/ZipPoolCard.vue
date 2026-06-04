<script setup lang="ts">
import { formatCompactUsdValue } from '~/utils/string-utils'

// Earn-page pool card (spec §10.1). Presentational — emits `deposit` so the
// page opens the deposit flow via useZipModals.
defineEmits<{ (e: 'deposit'): void }>()

const { protocolHealth } = useZipDemo()

const deployedPct = computed(() => {
  const h = protocolHealth.value
  const total = h.capitalDeployedUsd + h.idleUsdcReserveUsd
  return total > 0 ? Math.round((h.capitalDeployedUsd / total) * 100) : 0
})

const metrics = computed(() => {
  const h = protocolHealth.value
  return [
    { label: 'Total protocol NAV', value: formatCompactUsdValue(h.totalNavUsd) },
    { label: 'zipUSD minted', value: formatCompactUsdValue(h.zipUsdMinted) },
    { label: 'Available liquidity', value: formatCompactUsdValue(h.availableLiquidityUsd) },
    { label: 'Capital deployed', value: `${deployedPct.value}%` },
  ]
})
</script>

<template>
  <div class="zip-card p-28">
    <div class="flex items-start justify-between gap-16">
      <div>
        <p class="zip-eyebrow mb-8">
          Pool
        </p>
        <h2 class="zip-display text-[24px]">
          Zip Code HELOC Credit Pool
        </h2>
        <p
          class="mt-8 text-[15px] max-w-[420px]"
          style="color: var(--zip-text-muted)"
        >
          Warehouse-style credit for verified home-equity loan originators.
        </p>
      </div>
      <span class="zip-badge zip-badge--success shrink-0">
        <span class="zip-badge__dot" />Active
      </span>
    </div>

    <div class="grid grid-cols-2 gap-x-24 gap-y-16 mt-24 mb-8">
      <div
        v-for="m in metrics"
        :key="m.label"
        class="flex flex-col"
      >
        <span
          class="text-[13px]"
          style="color: var(--zip-text-muted)"
        >{{ m.label }}</span>
        <span class="text-[20px] font-semibold tabular-nums mt-2">{{ m.value }}</span>
      </div>
    </div>

    <ZipCapitalDeploymentBar
      class="mt-16"
      :deployed-usd="protocolHealth.capitalDeployedUsd"
      :idle-usdc="protocolHealth.idleUsdcReserveUsd"
    />

    <UiButton
      size="large"
      class="mt-24 w-full"
      @click="$emit('deposit')"
    >
      Deposit funds
    </UiButton>
  </div>
</template>
