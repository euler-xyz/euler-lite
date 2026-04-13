<script setup lang="ts">
import type { VaultAsset } from '~/entities/vault'
import type { DisplayStep } from '~/utils/stepDecoding'
import type { CowSwapExecutionStatus, CowSwapOrderStatus } from '~/entities/cowswap'

const props = defineProps<{
  collateralAsset: VaultAsset
  collateralAmount: string
  collateralVaultName: string
  borrowAsset: VaultAsset
  borrowAmount: string
  borrowVaultName: string
  swapOutAmount: string
  swapOutMinAmount: string
  needsCollateralApproval: boolean
  needsSellTokenApproval: boolean
  subAccount: string
  executionStatus: CowSwapExecutionStatus
  executionError: Error | null
  explorerUrl: string | undefined
  orderStatus: CowSwapOrderStatus | null
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

const isSubmitted = computed(() => props.executionStatus === 'submitted')
const isCancelling = ref(false)

const executionLabel = computed(() => {
  switch (props.executionStatus) {
    case 'approving_collateral': return 'Approving tokens — confirm in wallet...'
    case 'signing_permit': return 'Sign EVC permit in wallet...'
    case 'signing_order': return 'Sign CoW order in wallet...'
    case 'submitting': return 'Submitting order to CoW Protocol...'
    default: return null
  }
})

const orderStatusLabel = computed(() => {
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

const signSteps = computed<DisplayStep[]>(() => {
  const result: DisplayStep[] = []
  let idx = 1

  if (props.needsCollateralApproval) {
    result.push({
      index: idx++,
      label: 'Approve for deposit',
      isSeparateTx: true,
      assetInfo: {
        symbol: props.collateralAsset.symbol,
        address: props.collateralAsset.address,
        amount: props.collateralAmount,
      },
    })
  }

  if (props.needsSellTokenApproval) {
    result.push({
      index: idx++,
      label: 'Approve for swap',
      isSeparateTx: true,
      assetInfo: {
        symbol: props.borrowAsset.symbol,
        address: props.borrowAsset.address,
        amount: props.borrowAmount,
      },
    })
  }

  result.push({
    index: idx++,
    label: 'Sign EVC permit',
    isSeparateTx: false,
  })

  result.push({
    index: idx++,
    label: 'Sign CoW order',
    isSeparateTx: false,
  })

  return result
})

const wrapperSteps = computed<DisplayStep[]>(() => {
  const result: DisplayStep[] = []
  let idx = 1

  result.push({
    index: idx++,
    label: 'Enable collateral',
    labelSuffix: props.collateralVaultName,
    isSeparateTx: false,
  })

  result.push({
    index: idx++,
    label: 'Enable controller',
    labelSuffix: props.borrowVaultName,
    isSeparateTx: false,
  })

  result.push({
    index: idx++,
    label: 'Deposit collateral',
    isSeparateTx: false,
    assetInfo: {
      symbol: props.collateralAsset.symbol,
      address: props.collateralAsset.address,
      amount: props.collateralAmount,
    },
  })

  result.push({
    index: idx++,
    label: 'Borrow',
    isSeparateTx: false,
    assetInfo: {
      symbol: props.borrowAsset.symbol,
      address: props.borrowAsset.address,
      amount: props.borrowAmount,
    },
  })

  result.push({
    index: idx++,
    label: 'Swap',
    isSeparateTx: false,
    assetInfo: {
      symbol: props.borrowAsset.symbol,
      address: props.borrowAsset.address,
      amount: props.borrowAmount,
    },
    toAssetInfo: {
      symbol: props.collateralAsset.symbol,
      address: props.collateralAsset.address,
      amount: props.swapOutAmount,
    },
  })

  result.push({
    index: idx++,
    label: 'Deposit min.',
    isSeparateTx: false,
    assetInfo: {
      symbol: props.collateralAsset.symbol,
      address: props.collateralAsset.address,
      amount: props.swapOutMinAmount,
    },
  })

  return result
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

      <!-- Execution progress -->
      <UiToast
        v-if="executionLabel"
        :title="executionLabel"
        variant="info"
        size="compact"
        persistent
      />

      <!-- Submitted state -->
      <template v-if="isSubmitted">
        <UiToast
          :title="orderStatusLabel"
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
          v-if="!orderStatus?.terminal"
          variant="secondary"
          size="xlarge"
          rounded
          :disabled="isCancelling"
          :loading="isCancelling"
          @click="handleCancel"
        >
          {{ isCancelling ? 'Cancelling...' : 'Cancel Order' }}
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
