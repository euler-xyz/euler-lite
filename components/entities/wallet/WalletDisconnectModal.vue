<script setup lang="ts">
import { useDisconnect } from '@wagmi/vue'
import { getExplorerLink } from '~/utils/block-explorer'

const emits = defineEmits(['close'])

const { address } = useWagmi()
const { disconnect } = useDisconnect()
const { chainId } = useEulerAddresses()
const { isSpyMode, spyAddress, clearSpyMode } = useSpyMode()

const displayAddress = computed(() => isSpyMode.value ? spyAddress.value : address.value)
const explorerLink = computed(() => getExplorerLink(displayAddress.value, chainId.value, true))

const onCopyAddressClick = () => {
  navigator.clipboard.writeText(displayAddress.value || '')
}

const onDisconnectClick = () => {
  if (isSpyMode.value) {
    clearSpyMode()
  }
  else {
    disconnect()
  }
  emits('close')
}
</script>

<template>
  <BaseModalWrapper
    title="Wallet"
    @close="$emit('close')"
  >
    <div
      class="flex flex-col items-center gap-16 mb-16 -mt-8 py-6"
    >
      <div class="flex justify-center items-center gap-16">
        <div class="text-h3 text-center">
          {{ `${displayAddress?.slice(0, 6)}...${displayAddress?.slice(-4)}` }}
        </div>
        <UiButton
          variant="primary-stroke"
          size="medium"
          icon="copy"
          icon-only
          @click="onCopyAddressClick"
        />
        <NuxtLink
          v-if="displayAddress"
          :to="explorerLink"
          target="_blank"
          external
        >
          <UiButton
            variant="primary-stroke"
            size="medium"
            icon="arrow-top-right"
            icon-only
          />
        </NuxtLink>
      </div>
    </div>
    <UiButton
      variant="primary-stroke"
      size="xlarge"
      rounded
      icon="unlink"
      @click="onDisconnectClick"
    >
      {{ isSpyMode ? 'Exit spy mode' : 'Disconnect' }}
    </UiButton>
  </BaseModalWrapper>
</template>
