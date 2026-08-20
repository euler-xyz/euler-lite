<script setup lang="ts">
import type { Hash } from 'viem'
import { OperationReviewModal } from '#components'
import type { TrackedExecutionHandle } from '~/composables/useSafeExecutionDetachment'
import type { VaultAsset } from '~/types/asset'

const props = defineProps<{
  ceremonyId: Hash
  consentDigest: Hash
  review: Record<string, unknown> & { asset: { address: string, symbol: string, decimals: number, name?: string }, amount: number | string }
  onSucceeded?: () => void | Promise<void>
  onFailed?: (cause: unknown) => void | Promise<void>
}>()
const emit = defineEmits(['close'])

const { getCeremony, accept } = useTransactionCeremony()
const { beginTrackedExecution } = useSafeExecutionDetachment()
const isSubmitting = ref(false)
const operationReviewProps = computed(() => props.review as unknown as Record<string, unknown> & { asset: VaultAsset, amount: number | string })
const reviewedCeremony = computed(() => getCeremony(props.ceremonyId))
let pending: Promise<void> | undefined
let executionHandle: TrackedExecutionHandle | undefined

const acceptCeremony = () => {
  if (isSubmitting.value) return
  const ceremony = reviewedCeremony.value
  if (!ceremony || ceremony.consentDigest !== props.consentDigest) {
    void props.onFailed?.(new Error('Review binding is unavailable'))
    return
  }
  const handle = beginTrackedExecution({ safeAtSubmit: ceremony.template.wallet.walletKind === 'safe' })
  if (!handle) return
  executionHandle = handle
  isSubmitting.value = true
  pending = (async () => {
    try {
      await accept(props.ceremonyId, props.consentDigest)
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
    :ceremony-id="ceremonyId"
    :consent-digest="consentDigest"
    :ceremony-wallet-kind="reviewedCeremony?.template.wallet.walletKind"
    :ceremony-requests="reviewedCeremony?.template.requests"
    :external-submitting="isSubmitting"
    @confirm="acceptCeremony"
    @close="requestClose"
  />
</template>
