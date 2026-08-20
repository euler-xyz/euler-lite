<script setup lang="ts">
import type { Hash } from 'viem'
import { OperationReviewModal } from '#components'
import type { TrackedExecutionHandle } from '~/composables/useSafeExecutionDetachment'
import type { VaultAsset } from '~/types/asset'

const props = defineProps<{
  reviewId: Hash
  reviewDigest: Hash
  review: Record<string, unknown> & { asset: { address: string, symbol: string, decimals: number, name?: string }, amount: number | string }
  onSucceeded?: () => void | Promise<void>
  onFailed?: (cause: unknown) => void | Promise<void>
}>()
const emit = defineEmits(['close'])

const { getReviewedExecution, accept } = useReviewedExecution()
const { beginTrackedExecution } = useSafeExecutionDetachment()
const isSubmitting = ref(false)
const operationReviewProps = computed(() => props.review as unknown as Record<string, unknown> & { asset: VaultAsset, amount: number | string })
const executionRef = computed(() => getReviewedExecution(props.reviewId))
let pending: Promise<void> | undefined
let executionHandle: TrackedExecutionHandle | undefined

const acceptReview = () => {
  if (isSubmitting.value) return
  const execution = executionRef.value
  if (!execution || execution.reviewDigest !== props.reviewDigest) {
    void props.onFailed?.(new Error('Review binding is unavailable'))
    return
  }
  const handle = beginTrackedExecution({ safeAtSubmit: execution.requestSet.wallet.walletKind === 'safe' })
  if (!handle) return
  executionHandle = handle
  isSubmitting.value = true
  pending = (async () => {
    try {
      await accept(props.reviewId, props.reviewDigest)
      handle.scope.markSucceeded()
      if (!handle.scope.suppressPostTxUi()) {
        await props.onSucceeded?.()
        emit('close')
      }
    }
    catch (cause) {
      await props.onFailed?.(cause)
      throw cause
    }
    finally {
      isSubmitting.value = false
      pending = undefined
      executionHandle?.release()
      executionHandle = undefined
    }
  })()
  void pending.catch(() => {})
}

const requestClose = () => {
  if (!isSubmitting.value) {
    emit('close')
    return
  }
  if (executionHandle?.safeAtSubmit && pending) {
    executionHandle.detach(pending)
    executionHandle = undefined
    emit('close')
  }
}
</script>

<template>
  <OperationReviewModal
    v-bind="operationReviewProps"
    :review-id="reviewId"
    :review-digest="reviewDigest"
    :reviewed-wallet-kind="executionRef?.requestSet.wallet.walletKind"
    :reviewed-requests="executionRef?.requestSet.requests"
    :external-submitting="isSubmitting"
    @confirm="acceptReview"
    @close="requestClose"
  />
</template>
