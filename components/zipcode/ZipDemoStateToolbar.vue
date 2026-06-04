<script setup lang="ts">
// Developer-only toolbar (spec §5.4) to drive the demo into specific states
// during a walkthrough. Rendered only when `import.meta.dev` (see layout).
import type { RedemptionStatus } from '~/types/zipcode'
import { demoConfig } from '~/types/zipcode'

const {
  position,
  activeRedemptionRequest,
  hasRedemptionRequest,
  deposit,
  requestRedemption,
  setRedemptionDemoStatus,
  reset,
} = useZipDemo()

const collapsed = ref(true)
const busy = ref(false)

const statuses: { value: RedemptionStatus, label: string }[] = [
  { value: 'queued', label: 'Queued' },
  { value: 'partially-settled', label: 'Partial' },
  { value: 'claimable', label: 'Claimable' },
  { value: 'claimed', label: 'Claimed' },
]

const seedDeposit = async () => {
  busy.value = true
  await deposit(demoConfig.defaultDepositUsd, 'digital-dollar')
  busy.value = false
}

const seedRedemption = () => {
  if (position.value.zipUsdBalance <= 0 && !hasRedemptionRequest.value) {
    void seedDeposit().then(() => requestRedemption(demoConfig.defaultRedemptionZipUsd))
    return
  }
  requestRedemption(demoConfig.defaultRedemptionZipUsd)
}
</script>

<template>
  <div
    class="fixed bottom-16 left-16 z-[200] text-[12px] select-none"
    style="font-family: Inter, sans-serif"
  >
    <button
      v-if="collapsed"
      type="button"
      class="px-12 py-8 rounded-full shadow-lg text-white font-semibold tracking-wide"
      style="background: #102018"
      @click="collapsed = false"
    >
      ⚙ Demo
    </button>

    <div
      v-else
      class="zip-card p-12 w-260"
    >
      <div class="flex items-center justify-between mb-8">
        <span class="font-semibold">Demo controls</span>
        <button
          type="button"
          class="zip-muted"
          @click="collapsed = true"
        >
          ✕
        </button>
      </div>

      <p
        class="zip-muted mb-4"
      >
        Redemption status
      </p>
      <div class="grid grid-cols-2 gap-6 mb-10">
        <button
          v-for="s in statuses"
          :key="s.value"
          type="button"
          class="px-8 py-6 rounded-8 border text-left"
          :style="hasRedemptionRequest && activeRedemptionRequest.status === s.value
            ? 'background: var(--zip-brand-strong); color:#fff; border-color: transparent'
            : 'border-color: var(--zip-border)'"
          :disabled="!hasRedemptionRequest"
          @click="setRedemptionDemoStatus(s.value)"
        >
          {{ s.label }}
        </button>
      </div>

      <div class="flex flex-col gap-6">
        <button
          type="button"
          class="px-8 py-6 rounded-8 border"
          style="border-color: var(--zip-border)"
          :disabled="busy"
          @click="seedDeposit"
        >
          {{ busy ? 'Seeding…' : `Seed deposit ($${demoConfig.defaultDepositUsd.toLocaleString()})` }}
        </button>
        <button
          type="button"
          class="px-8 py-6 rounded-8 border"
          style="border-color: var(--zip-border)"
          @click="seedRedemption"
        >
          Seed redemption ({{ demoConfig.defaultRedemptionZipUsd.toLocaleString() }})
        </button>
        <button
          type="button"
          class="px-8 py-6 rounded-8 text-white"
          style="background: #c94d4d"
          @click="reset"
        >
          Reset demo
        </button>
      </div>
    </div>
  </div>
</template>
