<script setup lang="ts">
import { formatUnits } from 'viem'
import { useChainId } from '@wagmi/vue'
import { KeyringFlowState } from '~/composables/useKeyring'
import { getChainById } from '~/entities/chainRegistry'

const props = defineProps<{
  flowState: KeyringFlowState
  credentialCost?: number
  checkingStatus?: boolean
  statusMessage?: string
  errorMessage?: string
}>()

const chainId = useChainId()

const formattedCost = computed(() => {
  if (!props.credentialCost) return undefined
  const chain = getChainById(chainId.value)
  const symbol = chain?.nativeCurrency?.symbol ?? 'ETH'
  const decimals = chain?.nativeCurrency?.decimals ?? 18
  const value = formatUnits(BigInt(props.credentialCost), decimals)
  const num = parseFloat(value)
  if (num === 0) return undefined
  return `${num.toFixed(6)} ${symbol}`
})

defineEmits<{
  launch: []
  check: []
  cancel: []
}>()
</script>

<template>
  <div class="flex flex-col gap-12">
    <template v-if="flowState === KeyringFlowState.Loading">
      <UiButton
        variant="primary"
        size="large"
        disabled
        loading
      >
        Checking verification status...
      </UiButton>
    </template>

    <template v-else-if="flowState === KeyringFlowState.Install">
      <p class="text-p3 text-content-secondary text-center">
        The Keyring browser extension is required to complete verification.
      </p>
      <UiButton
        variant="primary"
        size="large"
        @click="$emit('launch')"
      >
        Install Keyring Extension
      </UiButton>
    </template>

    <template v-else-if="flowState === KeyringFlowState.Start">
      <p
        v-if="statusMessage"
        class="text-p3 text-content-secondary text-center"
      >
        {{ statusMessage }}
      </p>
      <UiButton
        variant="primary"
        size="large"
        @click="$emit('launch')"
      >
        Start Verification
      </UiButton>
    </template>

    <template v-else-if="flowState === KeyringFlowState.Progress">
      <p class="text-p3 text-content-secondary text-center">
        Complete the verification in the Keyring extension, then check your status.
      </p>
      <p
        v-if="statusMessage"
        class="text-p3 text-content-secondary text-center"
      >
        {{ statusMessage }}
      </p>
      <div class="flex flex-col gap-8">
        <UiButton
          variant="primary"
          size="large"
          :loading="checkingStatus"
          @click="$emit('check')"
        >
          Check Status
        </UiButton>
        <UiButton
          variant="secondary"
          size="large"
          @click="$emit('cancel')"
        >
          Cancel
        </UiButton>
      </div>
    </template>

    <template v-else-if="flowState === KeyringFlowState.Ready">
      <div class="flex flex-col gap-8 p-12 rounded-12 bg-success-100">
        <div class="flex items-center gap-8">
          <SvgIcon
            name="check-circle-filled"
            class="!w-20 !h-20 text-success-500 shrink-0"
          />
          <p class="text-p3 text-success-600 font-medium">
            Verification complete. Credential will be submitted with your transaction.
          </p>
        </div>
        <p
          v-if="formattedCost"
          class="text-p3 text-success-600 pl-28"
        >
          Keyring credential fee: {{ formattedCost }}
        </p>
      </div>
    </template>

    <template v-else-if="flowState === KeyringFlowState.Error">
      <div class="flex items-center gap-8 p-12 rounded-12 bg-error-100">
        <SvgIcon
          name="warning"
          class="!w-20 !h-20 text-error-500"
        />
        <p class="text-p3 text-error-600">
          {{ errorMessage || 'Verification failed. Please try again.' }}
        </p>
      </div>
      <UiButton
        variant="primary"
        size="large"
        @click="$emit('launch')"
      >
        Retry Verification
      </UiButton>
    </template>
  </div>
</template>
