<script setup lang="ts">
import type { DisplayStep } from '~/utils/stepDecoding'
import type { CowSwapExecutionStatus, CowSwapOrderStatus } from '~/entities/cowswap'

const props = defineProps<{
  signSteps: DisplayStep[]
  wrapperSteps: DisplayStep[]
  walletWarningsDescription?: string
  executionStatus: CowSwapExecutionStatus
  executionError: Error | null
  explorerUrl: string | undefined
  orderStatus: CowSwapOrderStatus | null
  locallyCancelled: boolean
  onConfirm: () => void
  onCancel: () => void
}>()

const emit = defineEmits<{
  close: []
}>()

const isExecuting = computed(() => {
  const s = props.executionStatus
  return s !== 'idle' && s !== 'submitted'
})

const isCancelling = ref(false)
const isCancelPending = computed(() => props.executionStatus === 'cancelling' || isCancelling.value)
const isSubmitted = computed(() => props.executionStatus === 'submitted' || isCancelPending.value)

const executionLabel = computed(() => {
  switch (props.executionStatus) {
    case 'approving_collateral': return 'Approving tokens — confirm in wallet...'
    case 'fetching_inbox': return 'Fetching order receiver...'
    case 'signing_permit': return 'Sign EVC permit in wallet...'
    case 'signing_order': return 'Sign CoW order in wallet...'
    case 'submitting': return 'Submitting order to CoW Protocol...'
    case 'cancelling': return 'Cancelling order...'
    default: return null
  }
})

const orderStatusLabel = computed(() => {
  if (isCancelPending.value) return 'Cancelling order'
  if (props.locallyCancelled) return 'Order cancelled'
  if (!props.orderStatus) return 'Waiting for solver...'
  switch (props.orderStatus.type) {
    case 'open': return 'Order open — waiting for solver...'
    case 'active': return 'Solver found — executing...'
    case 'solved': return 'Order solved — settling...'
    case 'executing': return 'Executing on-chain...'
    case 'traded': return 'Order filled'
    case 'fulfilled': return 'Order fulfilled'
    case 'cancelled': return 'Order cancelled'
    case 'expired': return 'Order expired'
    default: return 'Waiting for solver...'
  }
})

const orderStatusDescription = computed(() => {
  if (isCancelPending.value) {
    return 'We are cancelling the swap order.'
  }
  if (props.locallyCancelled) {
    return 'The cancellation request was submitted. CoW order status may take a moment to update.'
  }
  return undefined
})

const internalSubmitting = ref(false)

const handleConfirm = async () => {
  if (internalSubmitting.value) return
  internalSubmitting.value = true
  try {
    await Promise.resolve(props.onConfirm())
  }
  finally {
    internalSubmitting.value = false
  }
}

const handleCancel = async () => {
  isCancelling.value = true
  try {
    await props.onCancel()
  }
  finally {
    isCancelling.value = false
  }
}
</script>

<template>
  <BaseModalWrapper
    title="Transaction review"
    @close="emit('close')"
  >
    <div class="flex flex-col gap-24">
      <!-- Review steps (hidden after submission) -->
      <div
        v-if="!isSubmitted"
        class="bg-surface-secondary rounded-12 p-12 flex flex-col gap-4"
      >
        <OperationStepsList :steps="signSteps" />
        <div class="border-t border-border-primary my-4" />
        <p class="text-p4 text-content-tertiary mb-2">
          Executed atomically by CoW solver
        </p>
        <OperationStepsList :steps="wrapperSteps" />
      </div>

      <!-- Wallet signing notes (pre-submission) -->
      <UiToast
        v-if="!isSubmitted && walletWarningsDescription"
        title="Your wallet may show warnings"
        :description="walletWarningsDescription"
        variant="info"
        size="compact"
        persistent
      />

      <!-- Execution progress -->
      <UiToast
        v-if="executionLabel && !isSubmitted"
        :title="executionLabel"
        variant="info"
        size="compact"
        persistent
      />

      <!-- Submitted state -->
      <template v-if="isSubmitted">
        <UiToast
          :title="orderStatusLabel"
          :description="orderStatusDescription"
          variant="info"
          size="compact"
          persistent
        />

        <a
          v-if="explorerUrl"
          :href="explorerUrl"
          target="_blank"
          rel="noopener noreferrer"
          class="text-p3 text-content-primary text-center hover:underline"
        >
          View on CoW Explorer &rarr;
        </a>

        <UiButton
          v-if="!orderStatus?.terminal && !locallyCancelled"
          variant="secondary"
          size="xlarge"
          rounded
          :disabled="isCancelPending"
          :loading="isCancelPending"
          @click="handleCancel"
        >
          {{ isCancelPending ? 'Cancelling...' : 'Cancel Order' }}
        </UiButton>
      </template>

      <!-- Error -->
      <UiToast
        v-if="executionError"
        :title="executionError.message"
        variant="error"
        size="compact"
        persistent
      />

      <!-- Confirm button (pre-submission only) -->
      <UiButton
        v-if="!isSubmitted"
        variant="primary"
        size="xlarge"
        rounded
        :disabled="isExecuting || internalSubmitting"
        :loading="isExecuting || internalSubmitting"
        @click="handleConfirm"
      >
        {{ isExecuting ? executionLabel : 'Confirm & Sign' }}
      </UiButton>
    </div>
  </BaseModalWrapper>
</template>
