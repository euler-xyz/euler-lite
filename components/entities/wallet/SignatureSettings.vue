<script setup lang="ts">
const { signaturesEnabled, signaturesForcedOff, setSignaturesEnabled } = useSignaturePreference()
const { isSafeWallet } = useSafeWallet()
const { pendingHashlessBundles, clearVerifiedHashlessBundle } = usePendingSafeBundleRecovery()
const confirmations = ref<Record<string, boolean>>({})
const clearError = ref<string | undefined>()

// The forced-off flag also covers the brief detection-pending window; only
// show the Safe explanation once a Safe is positively identified.
const description = computed(() => isSafeWallet.value
  ? 'Safe wallets bundle approvals into the transaction batch, so message signatures are unavailable'
  : 'Use gasless message signatures instead of approval transactions')

const onToggle = (value: boolean | undefined) => {
  if (signaturesForcedOff.value) return
  setSignaturesEnabled(value ?? false)
}

const clearPendingBundle = async (reservationId: string) => {
  const pending = pendingHashlessBundles.value.find(item => item.reservationId === reservationId)
  if (!pending) return
  try {
    await clearVerifiedHashlessBundle({
      reservationId,
      account: pending.account,
      chainId: pending.chainId,
      confirmedAbsent: Boolean(confirmations.value[reservationId]),
    })
    confirmations.value[reservationId] = false
    clearError.value = undefined
  }
  catch (error) {
    clearError.value = error instanceof Error ? error.message : 'Unable to clear the Safe bundle lock.'
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
  </div>
  <div
    v-for="pending in pendingHashlessBundles"
    :key="pending.reservationId"
    class="mb-20 rounded-16 border border-warning-500 bg-card p-16"
  >
    <div class="text-p2 text-warning-500">
      Safe bundle status requires manual verification
    </div>
    <div class="mt-6 text-p3 text-content-muted">
      Account {{ pending.account }} on chain {{ pending.chainId }} is locked because no trustworthy Safe hash was returned. Check this exact account and chain in Safe. Clear the lock only if Safe shows that no proposal was created.
    </div>
    <label class="mt-12 flex items-start gap-8 text-p3">
      <UiCheckbox v-model="confirmations[pending.reservationId]" />
      <span>I verified this account and chain in Safe and confirmed that no proposal was created.</span>
    </label>
    <UiButton
      class="mt-12"
      variant="red-destructive"
      :disabled="!confirmations[pending.reservationId]"
      @click="clearPendingBundle(pending.reservationId)"
    >
      Clear verified Safe lock
    </UiButton>
  </div>
  <div
    v-if="clearError"
    class="mb-20 text-p3 text-red-500"
  >
    {{ clearError }}
  </div>
</template>
