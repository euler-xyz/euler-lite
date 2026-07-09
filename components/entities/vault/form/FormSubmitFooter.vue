<script setup lang="ts">
import type { BorrowVaultPair } from '~/types/borrow-pair'
import type { EVault, SecuritizeCollateralVault, PortfolioBorrowPosition, VaultEntity } from '@eulerxyz/euler-v2-sdk'
import type { DisabledReasonVariant } from '~/components/entities/vault/form/types'

// Shared submit footer used by the position action forms: an optional
// "Vault/Pair information" button stacked above the primary submit button,
// inside the grid-positioned wrapper `laptop:col-start-1 laptop:row-start-2`.
//
// The info button renders only when `infoVault` or `infoPair` is provided; the
// submit label is passed via the default slot.
defineProps<{
  // VaultFormInfoButton bindings (info button omitted when neither is set)
  infoVault?: EVault | SecuritizeCollateralVault
  infoPair?: BorrowVaultPair | PortfolioBorrowPosition<VaultEntity>
  infoDisabled?: boolean
  // VaultFormSubmit bindings
  submitDisabled?: boolean
  submitLoading?: boolean
  disabledReason?: string
  disabledReasonVariant?: DisabledReasonVariant
  canAddToBatch?: boolean
}>()
defineEmits<{ (e: 'add-to-batch'): void }>()
</script>

<template>
  <div class="flex flex-col gap-8 laptop:col-start-1 laptop:row-start-2">
    <VaultFormInfoButton
      v-if="infoVault || infoPair"
      :vault="infoVault"
      :pair="infoPair"
      :disabled="infoDisabled"
    />
    <VaultFormSubmit
      :disabled="submitDisabled"
      :loading="submitLoading"
      :disabled-reason="disabledReason"
      :disabled-reason-variant="disabledReasonVariant"
      :can-add-to-batch="canAddToBatch"
      @add-to-batch="$emit('add-to-batch')"
    >
      <slot />
    </VaultFormSubmit>
  </div>
</template>
