<script setup lang="ts">
// Deposit USDC → mint zipUSD 1:1 (spec §10.2). Multi-step modal driven by an
// internal `step`; success mutates the shared demo store via useZipDemo().
import { formatCurrency, formatZipUsd, formatUsdc, demoConfig } from '~/types/zipcode'

const emit = defineEmits<{ (e: 'close'): void, (e: 'prevent-close', value: boolean): void }>()

const { fundingSources, position, deposit } = useZipDemo()

type Step = 'amount' | 'source' | 'explain' | 'review' | 'processing' | 'success'
const step = ref<Step>('amount')

const amountStr = ref(String(demoConfig.defaultDepositUsd))
const amount = computed(() => Number(amountStr.value.replace(/[^0-9.]/g, '')) || 0)

const sourceId = ref(fundingSources.value.find(s => s.isPrimary)?.id ?? 'digital-dollar')
const selectedSource = computed(() => fundingSources.value.find(s => s.id === sourceId.value))

const available = computed(() => selectedSource.value?.balanceUsd ?? position.value.digitalDollarBalanceUsd)
const amountError = computed(() => amount.value > available.value)
const canContinue = computed(() => amount.value > 0 && !amountError.value)

// Lock the modal (block backdrop/X dismissal) during the mocked mint.
watch(step, (s) => {
  emit('prevent-close', s === 'processing')
})

const confirm = async () => {
  step.value = 'processing'
  await deposit(amount.value, sourceId.value)
  step.value = 'success'
}

const dismiss = () => emit('close')
const viewPortfolio = async () => {
  await navigateTo('/zipcode/portfolio')
  emit('close')
}

const title = computed(() => ({
  amount: 'Deposit digital dollars',
  source: 'Choose funding source',
  explain: 'Receive zipUSD',
  review: 'Review deposit',
  processing: '',
  success: '',
}[step.value]))
</script>

<template>
  <ZipModalShell
    :title="title"
    :can-close="step !== 'processing'"
    @close="dismiss"
  >
    <!-- Step 1: amount -->
    <div v-if="step === 'amount'">
      <label
        class="text-[13px]"
        style="color: var(--zip-text-muted)"
      >Amount</label>
      <UiInput
        v-model="amountStr"
        class="mt-6"
        input-mode="decimal"
        :error="amountError"
      />
      <div
        class="flex items-center justify-between mt-8 text-[13px]"
        style="color: var(--zip-text-muted)"
      >
        <span>Equivalent {{ formatUsdc(amount) }}</span>
        <button
          type="button"
          class="underline underline-offset-2"
          @click="amountStr = String(available)"
        >
          Available {{ formatCurrency(available) }}
        </button>
      </div>
      <div class="zip-card-muted p-16 mt-16 flex items-center justify-between">
        <span
          class="text-[14px]"
          style="color: var(--zip-text-muted)"
        >You receive</span>
        <span class="text-[16px] font-semibold tabular-nums">{{ formatZipUsd(amount) }}</span>
      </div>
      <p
        v-if="amountError"
        class="mt-8 text-[13px]"
        style="color: var(--zip-danger)"
      >
        Amount exceeds your available balance.
      </p>
      <UiButton
        size="large"
        class="mt-20 w-full"
        :disabled="!canContinue"
        @click="step = 'source'"
      >
        Continue
      </UiButton>
    </div>

    <!-- Step 2: source -->
    <div v-else-if="step === 'source'">
      <div class="flex flex-col gap-10">
        <button
          v-for="s in fundingSources"
          :key="s.id"
          type="button"
          class="flex items-start gap-12 p-16 rounded-14 border text-left transition-colors"
          :style="sourceId === s.id
            ? 'border-color: var(--zip-brand-strong); background: var(--zip-surface-muted)'
            : 'border-color: var(--zip-border)'"
          @click="sourceId = s.id"
        >
          <span
            class="mt-1 grid place-items-center w-18 h-18 rounded-full border-2 shrink-0"
            :style="sourceId === s.id ? 'border-color: var(--zip-brand-strong)' : 'border-color: var(--zip-border)'"
          >
            <span
              v-if="sourceId === s.id"
              class="w-8 h-8 rounded-full"
              style="background: var(--zip-brand-strong)"
            />
          </span>
          <span>
            <span class="block text-[15px] font-medium">{{ s.label }}</span>
            <span
              class="block text-[13px]"
              style="color: var(--zip-text-muted)"
            >{{ s.detail }}</span>
          </span>
        </button>
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
          @click="step = 'explain'"
        >
          Continue
        </UiButton>
      </div>
    </div>

    <!-- Step 3: explanation -->
    <div v-else-if="step === 'explain'">
      <p
        class="text-[15px]"
        style="color: var(--zip-text)"
      >
        Your deposit enters the Zip Code credit pool. You receive zipUSD at a 1:1 ratio.
      </p>
      <div class="zip-card-muted p-16 mt-16 flex flex-col gap-10">
        <div class="flex items-center justify-between text-[14px]">
          <span style="color: var(--zip-text-muted)">Deposit</span>
          <span class="font-medium tabular-nums">{{ formatUsdc(amount) }}</span>
        </div>
        <div class="flex items-center justify-between text-[14px]">
          <span style="color: var(--zip-text-muted)">zipUSD received</span>
          <span class="font-medium tabular-nums">{{ formatZipUsd(amount) }}</span>
        </div>
        <div class="flex items-center justify-between text-[14px]">
          <span style="color: var(--zip-text-muted)">Reference value</span>
          <span class="font-medium">$1.00 per zipUSD</span>
        </div>
      </div>
      <p
        class="text-[13px] mt-12"
        style="color: var(--zip-text-muted)"
      >
        You can hold zipUSD, request redemption later, or use the optional secondary-market exit.
      </p>
      <div class="flex items-center gap-12 mt-20">
        <UiButton
          variant="primary-stroke"
          @click="step = 'source'"
        >
          Back
        </UiButton>
        <UiButton
          class="flex-1"
          @click="step = 'review'"
        >
          Review deposit
        </UiButton>
      </div>
    </div>

    <!-- Step 4: review -->
    <div v-else-if="step === 'review'">
      <div class="flex flex-col gap-12">
        <div class="flex items-center justify-between">
          <span style="color: var(--zip-text-muted)">Deposit amount</span>
          <span class="font-semibold tabular-nums">{{ formatCurrency(amount) }}</span>
        </div>
        <div class="zip-divider" />
        <div class="flex items-center justify-between">
          <span style="color: var(--zip-text-muted)">Asset</span>
          <span class="tabular-nums">{{ formatUsdc(amount) }}</span>
        </div>
        <div class="flex items-center justify-between">
          <span style="color: var(--zip-text-muted)">zipUSD received</span>
          <span class="tabular-nums">{{ formatZipUsd(amount) }}</span>
        </div>
        <div class="flex items-center justify-between">
          <span style="color: var(--zip-text-muted)">Reference value</span>
          <span>$1.00</span>
        </div>
      </div>
      <div class="flex items-center gap-12 mt-20">
        <UiButton
          variant="primary-stroke"
          @click="step = 'explain'"
        >
          Back
        </UiButton>
        <UiButton
          class="flex-1"
          @click="confirm"
        >
          Confirm deposit
        </UiButton>
      </div>
    </div>

    <!-- Step 5: processing -->
    <div
      v-else-if="step === 'processing'"
      class="py-32 flex flex-col items-center text-center"
    >
      <UiLoader />
      <p class="mt-16 text-[16px]">
        Minting your zipUSD…
      </p>
    </div>

    <!-- Step 6: success -->
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
        Deposit confirmed
      </h3>
      <p
        class="text-[13px] mt-12"
        style="color: var(--zip-text-muted)"
      >
        You deposited
      </p>
      <p class="text-[28px] font-semibold tabular-nums">
        {{ formatCurrency(amount) }}
      </p>
      <p
        class="text-[13px] mt-8"
        style="color: var(--zip-text-muted)"
      >
        You received
      </p>
      <p class="text-[18px] font-semibold tabular-nums">
        {{ formatZipUsd(amount) }}
      </p>
      <UiButton
        size="large"
        class="mt-20 w-full"
        @click="viewPortfolio"
      >
        View portfolio
      </UiButton>
    </div>
  </ZipModalShell>
</template>
