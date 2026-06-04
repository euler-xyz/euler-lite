<script setup lang="ts">
// Claim settled USDC (spec §10.6).
import { formatUsdc } from '~/types/zipcode'

const emit = defineEmits<{ (e: 'close'): void, (e: 'prevent-close', value: boolean): void }>()

const { activeRedemptionRequest, claim } = useZipDemo()

type Step = 'claim' | 'processing' | 'success'
const step = ref<Step>('claim')
const destination = ref<'digital-dollar' | 'wallet'>('digital-dollar')
const claimedUsdc = ref(0)

const claimable = computed(() => activeRedemptionRequest.value.usdcClaimable)

watch(step, s => emit('prevent-close', s === 'processing'))

const confirm = async () => {
  step.value = 'processing'
  const { usdc } = await claim()
  claimedUsdc.value = usdc
  step.value = 'success'
}

const dismiss = () => emit('close')
const backToPortfolio = async () => {
  await navigateTo('/zipcode/portfolio')
  emit('close')
}
</script>

<template>
  <ZipModalShell
    :title="step === 'claim' ? 'Claim digital dollars' : ''"
    :can-close="step !== 'processing'"
    @close="dismiss"
  >
    <!-- Step 1 -->
    <div v-if="step === 'claim'">
      <p
        class="text-[13px]"
        style="color: var(--zip-text-muted)"
      >
        Available to claim
      </p>
      <p class="text-[32px] font-semibold tabular-nums">
        {{ formatUsdc(claimable) }}
      </p>

      <p
        class="text-[13px] mt-20 mb-8"
        style="color: var(--zip-text-muted)"
      >
        Destination
      </p>
      <div class="flex flex-col gap-10">
        <button
          v-for="d in [
            { id: 'digital-dollar', label: 'Digital-dollar balance' },
            { id: 'wallet', label: 'Connected wallet' },
          ]"
          :key="d.id"
          type="button"
          class="flex items-center gap-12 p-14 rounded-14 border text-left"
          :style="destination === d.id
            ? 'border-color: var(--zip-brand-strong); background: var(--zip-surface-muted)'
            : 'border-color: var(--zip-border)'"
          @click="destination = (d.id as 'digital-dollar' | 'wallet')"
        >
          <span
            class="grid place-items-center w-18 h-18 rounded-full border-2 shrink-0"
            :style="destination === d.id ? 'border-color: var(--zip-brand-strong)' : 'border-color: var(--zip-border)'"
          >
            <span
              v-if="destination === d.id"
              class="w-8 h-8 rounded-full"
              style="background: var(--zip-brand-strong)"
            />
          </span>
          <span class="text-[15px] font-medium">{{ d.label }}</span>
        </button>
      </div>

      <UiButton
        size="large"
        class="mt-20 w-full"
        :disabled="claimable <= 0"
        @click="confirm"
      >
        Confirm claim
      </UiButton>
    </div>

    <!-- Processing -->
    <div
      v-else-if="step === 'processing'"
      class="py-32 flex flex-col items-center text-center"
    >
      <UiLoader />
      <p class="mt-16 text-[16px]">
        Sending your USDC…
      </p>
    </div>

    <!-- Success -->
    <div
      v-else
      class="text-center"
    >
      <div
        class="mx-auto grid place-items-center w-56 h-56 rounded-full"
        style="background: var(--zip-brand-soft); color: #1f7a45"
      >
        <SvgIcon
          name="check"
          class="w-28 h-28"
        />
      </div>
      <h3 class="zip-display text-[22px] mt-16">
        Claim complete
      </h3>
      <p
        class="text-[13px] mt-12"
        style="color: var(--zip-text-muted)"
      >
        You received
      </p>
      <p class="text-[28px] font-semibold tabular-nums">
        {{ formatUsdc(claimedUsdc) }}
      </p>
      <UiButton
        size="large"
        class="mt-20 w-full"
        @click="backToPortfolio"
      >
        Return to portfolio
      </UiButton>
    </div>
  </ZipModalShell>
</template>
