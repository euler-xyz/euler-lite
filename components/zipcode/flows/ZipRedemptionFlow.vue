<script setup lang="ts">
// Request zipUSD redemption → enter the 30-day epoch queue (spec §10.4).
import { formatZipUsd, formatUsdc, formatDate, demoConfig } from '~/types/zipcode'

const emit = defineEmits<{ (e: 'close'): void }>()

const { position, requestRedemption } = useZipDemo()

type Step = 'amount' | 'queue' | 'review' | 'success'
const step = ref<Step>('amount')

const amountStr = ref(String(Math.min(demoConfig.defaultRedemptionZipUsd, position.value.zipUsdBalance || demoConfig.defaultRedemptionZipUsd)))
const amount = computed(() => Number(amountStr.value.replace(/[^0-9.]/g, '')) || 0)
const available = computed(() => position.value.zipUsdBalance)
const amountError = computed(() => amount.value > available.value)
const canContinue = computed(() => amount.value > 0 && !amountError.value)

const confirm = () => {
  requestRedemption(amount.value)
  step.value = 'success'
}

const dismiss = () => emit('close')
const viewStatus = async () => {
  await navigateTo('/zipcode/redeem/status')
  emit('close')
}

const title = computed(() => ({
  amount: 'Redeem zipUSD',
  queue: 'Redemption queue',
  review: 'Review redemption request',
  success: '',
}[step.value]))
</script>

<template>
  <ZipModalShell
    :title="title"
    @close="dismiss"
  >
    <!-- Step 1: amount -->
    <div v-if="step === 'amount'">
      <div
        class="flex items-center justify-between text-[13px] mb-6"
        style="color: var(--zip-text-muted)"
      >
        <span>Available zipUSD</span>
        <button
          type="button"
          class="underline underline-offset-2"
          @click="amountStr = String(available)"
        >
          {{ formatZipUsd(available) }}
        </button>
      </div>
      <UiInput
        v-model="amountStr"
        input-mode="decimal"
        :error="amountError"
      />
      <div class="zip-card-muted p-16 mt-16 flex items-center justify-between">
        <span
          class="text-[14px]"
          style="color: var(--zip-text-muted)"
        >Expected USDC</span>
        <span class="text-[16px] font-semibold tabular-nums">{{ formatUsdc(amount) }}</span>
      </div>
      <p
        v-if="amountError"
        class="mt-8 text-[13px]"
        style="color: var(--zip-danger)"
      >
        You can redeem at most {{ formatZipUsd(available) }}.
      </p>
      <UiButton
        size="large"
        class="mt-20 w-full"
        :disabled="!canContinue"
        @click="step = 'queue'"
      >
        Continue
      </UiButton>
    </div>

    <!-- Step 2: queue explanation -->
    <div v-else-if="step === 'queue'">
      <p class="text-[15px]">
        zipUSD redemption settles through a 30-day epoch queue.
      </p>
      <ul
        class="flex flex-col gap-8 mt-12 text-[14px]"
        style="color: var(--zip-text-muted)"
      >
        <li>· Available liquidity is allocated pro-rata</li>
        <li>· Filled amounts become claimable</li>
        <li>· Unfilled amounts roll into the next epoch</li>
      </ul>
      <div class="zip-card-muted p-16 mt-16 flex items-center justify-between">
        <span
          class="text-[14px]"
          style="color: var(--zip-text-muted)"
        >Current epoch ends</span>
        <span class="text-[15px] font-semibold">{{ formatDate(demoConfig.epochEnd) }}</span>
      </div>
      <div class="flex items-center gap-12 mt-20">
        <UiButton
          variant="primary-stroke"
          @click="step = 'amount'"
        >
          Back
        </UiButton>
        <UiButton
          class="flex-1"
          @click="step = 'review'"
        >
          Continue
        </UiButton>
      </div>
    </div>

    <!-- Step 3: review -->
    <div v-else-if="step === 'review'">
      <div class="flex flex-col gap-12">
        <div class="flex items-center justify-between">
          <span style="color: var(--zip-text-muted)">zipUSD queued</span>
          <span class="font-semibold tabular-nums">{{ formatZipUsd(amount) }}</span>
        </div>
        <div class="flex items-center justify-between">
          <span style="color: var(--zip-text-muted)">Expected USDC</span>
          <span class="tabular-nums">{{ formatUsdc(amount) }}</span>
        </div>
        <div class="flex items-center justify-between">
          <span style="color: var(--zip-text-muted)">Epoch settlement</span>
          <span>{{ formatDate(demoConfig.epochEnd) }}</span>
        </div>
        <div class="flex items-center justify-between">
          <span style="color: var(--zip-text-muted)">Cancellation</span>
          <span>Unavailable after request</span>
        </div>
      </div>
      <div class="flex items-center gap-12 mt-20">
        <UiButton
          variant="primary-stroke"
          @click="step = 'queue'"
        >
          Back
        </UiButton>
        <UiButton
          class="flex-1"
          @click="confirm"
        >
          Confirm redemption request
        </UiButton>
      </div>
    </div>

    <!-- Step 4: success -->
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
        Redemption requested
      </h3>
      <p
        class="text-[14px] mt-12"
        style="color: var(--zip-text-muted)"
      >
        Your zipUSD has entered the redemption queue.
      </p>
      <p
        class="text-[13px] mt-12"
        style="color: var(--zip-text-muted)"
      >
        Queued
      </p>
      <p class="text-[24px] font-semibold tabular-nums">
        {{ formatZipUsd(amount) }}
      </p>
      <p
        class="text-[13px] mt-8"
        style="color: var(--zip-text-muted)"
      >
        Current epoch settles {{ formatDate(demoConfig.epochEnd) }}
      </p>
      <UiButton
        size="large"
        class="mt-20 w-full"
        @click="viewStatus"
      >
        View redemption status
      </UiButton>
    </div>
  </ZipModalShell>
</template>
