<script setup lang="ts">
const { signaturesEnabled, signaturesForcedOff, setSignaturesEnabled } = useSignaturePreference()
const { isSafeWallet } = useSafeWallet()

// The forced-off flag also covers the brief detection-pending window; only
// show the Safe explanation once a Safe is positively identified.
const description = computed(() => isSafeWallet.value
  ? 'Safe wallets bundle approvals into the transaction batch, so message signatures are unavailable'
  : 'Use gasless message signatures instead of approval transactions')

const onToggle = (value: boolean | undefined) => {
  if (signaturesForcedOff.value) return
  setSignaturesEnabled(value ?? false)
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
</template>
