<script setup lang="ts">
import type { ToastVariant } from '~/components/ui/toast.types'
import type { DisplayStep } from '~/utils/stepDecoding'
import {
  formatCowSwapExecutionErrorMessage,
  type CowSwapCancellationMode,
  type CowSwapCancellationStatus,
  type CowSwapExecutionStatus,
  type CowSwapOrderStatus,
} from '~/entities/cowswap'
import { resolveCowSwapReviewState } from './cowSwapReviewState'

const props = defineProps<{
  signSteps: DisplayStep[]
  wrapperSteps: DisplayStep[]
  walletWarningsDescription?: string
  executionStatus: CowSwapExecutionStatus
  executionError: Error | null
  explorerUrl: string | undefined
  orderStatus: CowSwapOrderStatus | null
  locallyCancelled: boolean
  cancellationMode?: CowSwapCancellationMode
  cancellationStatus: CowSwapCancellationStatus
  onConfirm: () => void
  onCancel: () => void
}>()

const emit = defineEmits<{
  'close': []
  'prevent-close': [value: boolean]
}>()

const isExecuting = computed(() => {
  const s = props.executionStatus
  return s !== 'idle' && s !== 'submitted'
})

const isCancelling = ref(false)
const reviewState = computed(() => resolveCowSwapReviewState({
  executionStatus: props.executionStatus,
  orderStatus: props.orderStatus,
  locallyCancelled: props.locallyCancelled,
  cancellationMode: props.cancellationMode,
  cancellationStatus: props.cancellationStatus,
  isLocallyCancelling: isCancelling.value,
}))
const isCancelPending = computed(() => reviewState.value.isCancelPending)
const isSubmitted = computed(() => props.executionStatus === 'submitted' || isCancelPending.value)
const canCancelOrder = computed(() => reviewState.value.canCancelOrder)
const showSoftCancelWarning = computed(() => reviewState.value.showSoftCancelWarning)

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

const orderStatusLabel = computed(() => reviewState.value.orderStatusLabel)
const orderStatusDescription = computed(() => reviewState.value.orderStatusDescription)
const orderStatusVariant = computed<ToastVariant>(() => reviewState.value.orderStatusVariant)
const executionErrorMessage = computed(() =>
  props.executionError ? formatCowSwapExecutionErrorMessage(props.executionError) : undefined,
)

const internalSubmitting = ref(false)
const hasUnresolvedSubmittedOrder = computed(() => reviewState.value.hasUnresolvedSubmittedOrder)
const canClose = computed(() => !internalSubmitting.value && !hasUnresolvedSubmittedOrder.value)

watch(
  canClose,
  value => emit('prevent-close', !value),
  { immediate: true },
)

const handleClose = () => {
  if (!canClose.value) return
  emit('close')
}

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
  if (isCancelling.value) return
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
    :close="canClose"
    @close="handleClose"
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
          class="cow-swap-review-status"
          :title="orderStatusLabel"
          :description="orderStatusDescription"
          :variant="orderStatusVariant"
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

        <UiToast
          v-if="showSoftCancelWarning"
          title="Cancellation is not guaranteed"
          description="CoW cancellations are soft. This order may still fill until CoW reports it cancelled."
          variant="warning"
          size="compact"
          persistent
        />

        <UiButton
          v-if="canCancelOrder"
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
        v-if="executionErrorMessage"
        title="Something went wrong"
        :description="executionErrorMessage"
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

<style scoped>
.cow-swap-review-status {
  box-shadow: none;
}

.cow-swap-review-status :deep(.ui-toast__body) {
  align-items: flex-start;
  gap: 11px;
  padding: 15px 16px;
}

.cow-swap-review-status :deep(.ui-toast__icon) {
  margin-top: 2px;
}

.cow-swap-review-status :deep(.ui-toast__content) {
  gap: 4px;
}

.cow-swap-review-status :deep(.ui-toast__title) {
  font-size: 13px;
  line-height: 18px;
}

.cow-swap-review-status :deep(.ui-toast__description) {
  max-width: 64ch;
  font-size: 13px;
  line-height: 19px;
}
</style>
