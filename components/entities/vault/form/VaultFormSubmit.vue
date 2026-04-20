<script setup lang="ts">
import { inject } from 'vue'
import { useAccount } from '@wagmi/vue'
import { flip, offset, shift, useFloating } from '@floating-ui/vue'

import { isOperationBlocked, operationBlockReason } from '~/utils/operationGuardRegistry'
import type { DisabledReasonVariant } from '~/components/entities/vault/form/types'
import { useModal } from '~/components/ui/composables/useModal'
import { AcknowledgeTermsModal, VaultUnverifiedDisclaimerModal } from '#components'
import type { KeyringFlowState, CredentialData } from '~/composables/useKeyring'
import type { TosGuardState } from '~/composables/guards/useTosGuard'
import type { UnverifiedVaultGuardState } from '~/composables/guards/useUnverifiedVaultGuard'

interface KeyringGuardState {
  needsVerification: boolean
  isExpired: boolean
  flowState: KeyringFlowState
  credentialData: CredentialData | null
  launchExtension: () => Promise<void>
  checkStatus: () => Promise<void>
  cancelVerification: () => void
}

const props = defineProps<{ disabled?: boolean, loading?: boolean, disabledReason?: string, disabledReasonVariant?: DisabledReasonVariant }>()
const { isConnected } = useAccount()
const { chainId: _chainId } = useEulerAddresses()
const { chainId, switchChain, connect } = useWagmi()
const modal = useModal()

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
  return isConnected.value && chainId.value !== _chainId.value
})
const _disabled = computed(() => {
  if (isOperationBlocked.value) return true
  return props.disabled && !needToSwitchChain.value
})

const GENERIC_DISABLED_REASON = 'Complete the form fields above to continue.'

const effectiveDisabledReason = computed(() => {
  if (props.disabledReason) return props.disabledReason
  if (operationBlockReason.value) return operationBlockReason.value
  if (_disabled.value && !props.loading) return GENERIC_DISABLED_REASON
  return undefined
})

const tooltipVariantClass = computed(() => {
  if (props.disabledReason && props.disabledReasonVariant) {
    return `vault-form-submit__tooltip--${props.disabledReasonVariant}`
  }
  if (operationBlockReason.value) return 'vault-form-submit__tooltip--warning'
  return ''
})

const showTooltip = () => {
  if (_disabled.value && !props.loading) {
    isTooltipVisible.value = true
    update()
  }
}
const hideTooltip = () => {
  isTooltipVisible.value = false
}

const onClick = (e: Event) => {
  if (needToSwitchChain.value) {
    e.preventDefault()
    switchChain({ chainId: _chainId.value })
    return
  }
  if (!isConnected.value) {
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
</script>

<template>
  <div
    ref="reference"
    class="vault-form-submit"
    @mouseenter="showTooltip"
    @mouseleave="hideTooltip"
  >
    <!-- Keyring verification flow replaces the button when verification is needed -->
    <template v-if="showKeyringFlow && keyringGuard">
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
        :loading="loading"
        :disabled="_disabled"
        @click="onClick"
      >
        <template v-if="needToSwitchChain">
          Switch chain
        </template>
        <slot v-else-if="isConnected" />
        <template v-else>
          Connect wallet
        </template>
      </UiButton>
      <div
        v-if="isTooltipVisible && _disabled && !loading"
        ref="floating"
        :style="floatingStyles"
        :class="['vault-form-submit__tooltip', tooltipVariantClass]"
      >
        {{ effectiveDisabledReason }}
      </div>
    </template>
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
