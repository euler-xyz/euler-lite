<script setup lang="ts">
import { useToast } from '~/components/ui/composables/useToast'

const { signaturesEnabled, signaturesForcedOff, setSignaturesEnabled } = useSignaturePreference()
const { isSafeWallet } = useSafeWallet()
const { current: pendingSafeSubmission, storageError, clearConfirmedAbsent } = usePendingSafeReviewedSubmission()
const { error, success } = useToast()

// The forced-off flag also covers the brief detection-pending window; only
// show the Safe explanation once a Safe is positively identified.
const description = computed(() => isSafeWallet.value
  ? 'Safe wallets bundle approvals into the transaction batch, so message signatures are unavailable'
  : 'Use gasless message signatures instead of approval transactions')

const onToggle = (value: boolean | undefined) => {
  if (signaturesForcedOff.value) return
  setSignaturesEnabled(value ?? false)
}

const clearHashlessReservation = () => {
  const pending = pendingSafeSubmission.value
  if (!pending || pending.callsId) return
  try {
    clearConfirmedAbsent(pending)
    success('Safe submission lock cleared')
  }
  catch (cause) {
    error(cause instanceof Error ? cause.message : 'Unable to clear the Safe submission lock')
  }
}
</script>

<template>
  <div class="mb-20 rounded-16 border border-line-default bg-card p-16">
    <div class="flex items-center justify-between">
      <div>
        <div class="text-p2">
          Gasless signatures
        </div>
        <div class="text-p3 text-content-muted">
          {{ description }}
        </div>
      </div>
      <UiSwitch
        :model-value="signaturesEnabled"
        :disabled="signaturesForcedOff"
        @update:model-value="onToggle"
      />
    </div>
    <UiAlert
      v-if="pendingSafeSubmission"
      class="mt-12"
      variant="warning"
      size="compact"
      title="Previous Safe submission unresolved"
      :description="pendingSafeSubmission.callsId
        ? `Safe calls ID ${pendingSafeSubmission.callsId} will be reconciled before another proposal is allowed.`
        : 'No calls ID was returned. Check Safe for this account and chain before clearing the local submission lock.'"
    />
    <UiButton
      v-if="pendingSafeSubmission && !pendingSafeSubmission.callsId"
      class="mt-12"
      variant="secondary"
      size="small"
      @click="clearHashlessReservation"
    >
      I confirmed no proposal exists — clear lock
    </UiButton>
    <p
      v-if="storageError"
      class="mt-12 text-p3 text-content-negative"
    >
      {{ storageError }}
    </p>
  </div>
</template>
