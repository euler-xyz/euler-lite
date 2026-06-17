<script setup lang="ts">
import { inject } from 'vue'
import { flip, offset, shift, useFloating } from '@floating-ui/vue'

import { isOperationBlocked, operationBlockReason } from '~/utils/operationGuardRegistry'
import type { DisabledReasonVariant } from '~/components/entities/vault/form/types'
import { useModal } from '~/components/ui/composables/useModal'
import { AcknowledgeTermsModal, VaultUnverifiedDisclaimerModal } from '#components'
import type { KeyringFlowState, CredentialData } from '~/composables/useKeyring'
import type { TosGuardState } from '~/composables/guards/useTosGuard'
import type { UnverifiedVaultGuardState } from '~/composables/guards/useUnverifiedVaultGuard'
import { useStateOverrideResolution } from '~/composables/useStateOverrideOptions'

interface KeyringGuardState {
  needsVerification: boolean
  isExpired: boolean
  flowState: KeyringFlowState
  credentialData: CredentialData | null
  launchExtension: () => Promise<void>
  checkStatus: () => Promise<void>
  cancelVerification: () => void
}

const props = defineProps<{
  disabled?: boolean
  loading?: boolean
  disabledReason?: string
  disabledReasonVariant?: DisabledReasonVariant
  /** When defined, the form supports batching: a "+" segment is shown next to the
   *  main button, enabled when `canAddToBatch` is true, emitting `add-to-batch`. */
  canAddToBatch?: boolean
}>()
const emit = defineEmits<{ (e: 'add-to-batch'): void }>()
const { settings } = useUserSettings()
// The form opts into the "+ add to batch" affordance by binding `canAddToBatch`,
// but the "+" only shows when advanced mode is enabled in settings.
const supportsBatch = computed(() => props.canAddToBatch !== undefined && settings.value.enableAdvancedMode)
const { isConnected } = useWagmi()
const { isSpyMode } = useSpyMode()
const { chainId: _chainId } = useEulerAddresses()
const { chainId, switchChain, connect } = useWagmi()
const { isResolvingStateOverrideHints } = useStateOverrideResolution()
const { entryCount, clearBatch } = useTxBatch()
const modal = useModal()

// A non-empty batch blocks direct execution: the form would build & send its own
// EVC tx, ignoring the queued batch. The user must clear the batch (or add this
// op to it) first. The "Add to batch" button next to this one stays enabled.
const BATCH_ACTIVE_REASON = 'A transaction batch is pending. Add this to the batch, or clear it from the batch drawer to execute directly.'
const isBatchActive = computed(() => entryCount.value > 0)
// When a batch is queued and the user could otherwise execute directly, the
// batch state takes over the button area (ahead of the keyring/TOS/unverified
// gateways, which are all just pre-steps to a direct execute).
const batchBlocksDirect = computed(() =>
  isBatchActive.value && hasActiveSession.value && !needToSwitchChain.value,
)

const keyringGuard = inject<KeyringGuardState | null>('keyring-guard', null)
const tosGuard = inject<TosGuardState | null>('tos-guard', null)
const unverifiedVaultGuard = inject<UnverifiedVaultGuardState | null>('unverified-vault-guard', null)

const reference = ref(null)
const floating = ref(null)
const isTooltipVisible = ref(false)

const { floatingStyles, update } = useFloating(reference, floating, {
  placement: 'top',
  middleware: [
    offset({ mainAxis: 8 }),
    flip({ padding: 8 }),
    shift({ padding: 8 }),
  ],
})

const needToSwitchChain = computed(() => {
  return !isSpyMode.value && isConnected.value && chainId.value !== _chainId.value
})
const hasActiveSession = computed(() => isConnected.value || isSpyMode.value)
const _disabled = computed(() => {
  if (isOperationBlocked.value) return true
  if (isResolvingStateOverrideHints.value) return true
  return props.disabled && !needToSwitchChain.value
})
const isLoading = computed(() => props.loading || isResolvingStateOverrideHints.value)

const GENERIC_DISABLED_REASON = 'Complete the form fields above to continue.'

const effectiveDisabledReason = computed(() => {
  // Batch first: when the batch branch is rendered it's the relevant explanation,
  // ahead of operation-block / TOS reasons (those gate direct execute, which the
  // batch already blocks).
  if (batchBlocksDirect.value) return BATCH_ACTIVE_REASON
  if (operationBlockReason.value) return operationBlockReason.value
  if (props.disabledReason) return props.disabledReason
  if (_disabled.value && !isLoading.value) return GENERIC_DISABLED_REASON
  return undefined
})

// Hovering the "+" shows a neutral "add to batch" hint in the same floating
// tooltip; hovering the main button shows the (red/warning) disabled reason.
const PLUS_TOOLTIP = 'Add this operation to the transaction batch'
const isPlusHover = ref(false)

const tooltipVariantClass = computed(() => {
  if (isPlusHover.value && !isAddToBatchDisabled.value) return '' // neutral — it's an informational hint, not an error
  if (operationBlockReason.value) return 'vault-form-submit__tooltip--warning'
  if (props.disabledReason && props.disabledReasonVariant) {
    return `vault-form-submit__tooltip--${props.disabledReasonVariant}`
  }
  return ''
})

const showTooltip = () => {
  if ((_disabled.value || batchBlocksDirect.value) && !isLoading.value) {
    isTooltipVisible.value = true
    // Defer update until after v-if mounts the floating element,
    // otherwise the first paint lands at the wrapper's origin.
    nextTick(update)
  }
}
const hideTooltip = () => {
  if (isPlusHover.value) return // still hovering the "+" — keep its hint up
  isTooltipVisible.value = false
}
const onPlusEnter = () => {
  isPlusHover.value = true
  isTooltipVisible.value = true
  nextTick(update)
}
const onPlusLeave = () => {
  isPlusHover.value = false
  isTooltipVisible.value = false
}

const onClick = (e: Event) => {
  if (needToSwitchChain.value) {
    e.preventDefault()
    switchChain({ chainId: _chainId.value })
    return
  }
  if (!hasActiveSession.value) {
    e.preventDefault()
    connect()
    return
  }
}

const showKeyringFlow = computed(() =>
  keyringGuard?.needsVerification === true,
)

const showTosFlow = computed(() =>
  !showKeyringFlow.value && tosGuard?.isTermsRequired === true && !tosGuard?.tosLoadFailed,
)

const showUnverifiedVaultFlow = computed(() =>
  !showKeyringFlow.value && !showTosFlow.value && unverifiedVaultGuard?.isAcknowledgmentRequired === true,
)

const openUnverifiedVaultModal = () => {
  modal.open(VaultUnverifiedDisclaimerModal, {
    props: {
      acceptAction: () => {
        unverifiedVaultGuard?.acknowledgeRisk()
      },
    },
  })
}

const openTermsModal = () => {
  modal.open(AcknowledgeTermsModal, {
    props: {
      onReject: () => {
        modal.close()
      },
      onAccept: () => {
        tosGuard?.acceptTerms()
        modal.close()
      },
    },
  })
}

// Adding to the batch must clear the same gates as a direct execute — a queued
// op still gets executed. The TOS gate was sidesteppable via "Add to batch"
// before; now the add is blocked by any active operation guard, and when terms
// are required it routes through the acceptance modal first (accept → record →
// add), so the user can't batch without accepting.
const isAddToBatchBlocked = computed(() => isOperationBlocked.value && !showTosFlow.value)
const isAddToBatchDisabled = computed(() => {
  if (!props.canAddToBatch) return true
  if (isAddToBatchBlocked.value) return true
  if (isResolvingStateOverrideHints.value) return true
  if (needToSwitchChain.value) return true
  if (!hasActiveSession.value) return true
  if (props.disabled) return true
  return false
})

const addToBatchDisabledReason = computed(() => {
  if (needToSwitchChain.value) return 'Switch to the correct chain before adding this operation to the batch.'
  if (!hasActiveSession.value) return 'Connect a wallet before adding this operation to the batch.'
  if (operationBlockReason.value) return operationBlockReason.value
  if (props.disabledReason) return props.disabledReason
  if (props.disabled || isResolvingStateOverrideHints.value || !props.canAddToBatch) return GENERIC_DISABLED_REASON
  return undefined
})

const tooltipText = computed(() => {
  if (!isPlusHover.value) return effectiveDisabledReason.value
  return isAddToBatchDisabled.value ? addToBatchDisabledReason.value : PLUS_TOOLTIP
})

const handleAddToBatch = () => {
  if (showTosFlow.value) {
    modal.open(AcknowledgeTermsModal, {
      props: {
        onReject: () => modal.close(),
        onAccept: () => {
          tosGuard?.acceptTerms()
          modal.close()
          emit('add-to-batch')
        },
      },
    })
    return
  }
  if (isAddToBatchDisabled.value) return
  emit('add-to-batch')
}
</script>

<template>
  <div
    ref="reference"
    class="vault-form-submit"
    @mouseenter="showTooltip"
    @mouseleave="hideTooltip"
  >
    <div class="flex flex-col gap-8">
      <!-- A queued batch blocks direct execution. When this form can batch, the
         primary action becomes "Add to batch" (Option B) rather than a disabled
         execute button + a separate "+". Direct execute resumes once the batch
         is cleared (link below). -->
      <template v-if="batchBlocksDirect && supportsBatch">
        <UiButton
          size="large"
          variant="primary"
          :disabled="isAddToBatchDisabled"
          data-testid="add-to-batch"
          @click="handleAddToBatch"
        >
          <span class="inline-flex items-center gap-6">
            <span class="text-h5 leading-none">+</span>
            Add to batch
          </span>
        </UiButton>
      </template>

      <!-- Batch is pending but this form doesn't support batching: keep the
         disabled execute button with the explanatory info icon. -->
      <template v-else-if="batchBlocksDirect">
        <UiButton
          size="large"
          variant="primary"
          :disabled="true"
          data-testid="batch-blocks-direct"
        >
          <span class="inline-flex items-center gap-6">
            <slot />
            <SvgIcon
              name="info-circle"
              class="!w-16 !h-16 opacity-80"
            />
          </span>
        </UiButton>
      </template>

      <!-- Keyring verification flow replaces the button when verification is needed -->
      <template v-else-if="showKeyringFlow && keyringGuard">
        <div class="flex flex-col gap-12">
          <KeyringAlert :is-expired="keyringGuard.isExpired" />
          <KeyringVerificationFlow
            :flow-state="keyringGuard.flowState"
            :credential-cost="keyringGuard.credentialData?.cost"
            @launch="keyringGuard.launchExtension()"
            @check="keyringGuard.checkStatus()"
            @cancel="keyringGuard.cancelVerification()"
          />
        </div>
      </template>

      <!-- TOS acceptance flow -->
      <template v-else-if="showTosFlow">
        <UiButton
          size="large"
          variant="primary"
          @click="openTermsModal"
        >
          Accept Terms Of Use
        </UiButton>
      </template>

      <!-- Unverified vault acknowledgment flow -->
      <template v-else-if="showUnverifiedVaultFlow">
        <UiButton
          size="large"
          variant="red"
          @click="openUnverifiedVaultModal"
        >
          Acknowledge Unverified Vault Risk
        </UiButton>
      </template>

      <!-- Normal submit button -->
      <template v-else>
        <UiButton
          v-bind="$attrs"
          size="large"
          type="submit"
          :variant="needToSwitchChain ? 'red' : 'primary'"
          :loading="isLoading"
          :disabled="_disabled"
          @click="onClick"
        >
          <template v-if="needToSwitchChain">
            Switch chain
          </template>
          <slot v-else-if="hasActiveSession" />
          <template v-else>
            Connect wallet
          </template>
        </UiButton>
      </template>

      <!-- Labeled "Add to batch": the secondary action in the empty-batch state
           (replaces the bare "+"). Becomes the primary full-width button once a
           batch is pending — see the Option B branch above. -->
      <button
        v-if="supportsBatch && !batchBlocksDirect"
        type="button"
        class="w-full h-48 flex items-center justify-center gap-6 text-accent-500 text-h6 disabled:opacity-40 transition-opacity hover:opacity-80"
        :disabled="isAddToBatchDisabled"
        data-testid="add-to-batch"
        @click="handleAddToBatch"
        @mouseenter="onPlusEnter"
        @mouseleave="onPlusLeave"
      >
        <span class="text-h5 leading-none">+</span>
        Add to batch
      </button>
    </div>

    <!-- While a batch is pending, explain that direct execute is paused and offer
         a one-click clear (so the user isn't stuck with a disabled action). -->
    <p
      v-if="batchBlocksDirect"
      class="mt-8 text-center text-p3 text-content-tertiary"
    >
      Direct execute is paused while a batch is pending ·
      <button
        type="button"
        class="text-accent-500 hover:text-accent-600"
        data-testid="form-clear-batch"
        @click="clearBatch"
      >
        Clear batch
      </button>
    </p>

    <!-- Shared disabled-reason tooltip: covers the normal disabled state AND the
         batch-blocked button (info icon). Hovering the wrapper shows the reason. -->
    <div
      v-if="isTooltipVisible && tooltipText && !isLoading"
      ref="floating"
      :style="floatingStyles"
      :class="['vault-form-submit__tooltip', tooltipVariantClass]"
    >
      {{ tooltipText }}
    </div>
  </div>
</template>

<style lang="scss">
.vault-form-submit {
  position: relative;
  width: 100%;

  .ui-button {
    width: 100%;
  }

  &__tooltip {
    position: absolute;
    z-index: 10;
    max-width: 300px;
    padding: 8px 12px;
    border-radius: 8px;
    border: 1px solid transparent;
    background-color: var(--ui-footnote-floating-background-color);
    box-shadow: 0 8px 32px var(--ui-footnote-floating-box-shadow-color);
    font-size: 13px;
    line-height: 18px;
    font-weight: 400;
    text-align: center;
    pointer-events: none;

    &--warning {
      background-color: var(--ui-footnote-floating-background-color);
      background-image: linear-gradient(var(--ui-toast-warning-background-color), var(--ui-toast-warning-background-color));
      border-color: var(--ui-toast-warning-border-color);
      color: var(--ui-toast-warning-text-color);
      box-shadow: none;
    }

    &--error {
      background-color: var(--ui-footnote-floating-background-color);
      background-image: linear-gradient(var(--ui-toast-error-background-color), var(--ui-toast-error-background-color));
      border-color: var(--ui-toast-error-border-color);
      color: var(--ui-toast-error-text-color);
      box-shadow: none;
    }
  }
}
</style>
