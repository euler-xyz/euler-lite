<script setup lang="ts">
// Wallet controls for the Zip Code nav — chain selector + Connect wallet +
// settings, reusing euler's wallet system (useWagmi + AppKit). Connects a real
// wallet against the configured chain (the local anvil mainnet fork).
import { SelectChainModal, WalletDisconnectModal } from '#components'
import { useModal } from '~/components/ui/composables/useModal'

const { connect, address, isConnected } = useWagmi()
const modal = useModal()

const shortAddress = computed(() => {
  const a = address.value
  return a ? `${a.slice(0, 6)}…${a.slice(-4)}` : ''
})

const onWalletClick = () => {
  if (isConnected.value) modal.open(WalletDisconnectModal)
  else connect()
}

const onChainClick = () => modal.open(SelectChainModal)
</script>

<template>
  <div class="flex items-center gap-8 shrink-0">
    <!-- Chain selector -->
    <button
      type="button"
      aria-label="Select network"
      class="grid place-items-center w-40 h-40 rounded-12 border"
      style="border-color: var(--zip-border); background: var(--zip-surface)"
      @click="onChainClick"
    >
      <SvgIcon
        name="globe"
        class="w-18 h-18"
        style="color: var(--zip-text-muted)"
      />
    </button>

    <!-- Connect wallet -->
    <UiButton
      :variant="isConnected ? 'primary-stroke' : 'primary'"
      :icon="isConnected ? undefined : 'plus'"
      @click="onWalletClick"
    >
      {{ isConnected ? shortAddress : 'Connect wallet' }}
    </UiButton>

    <!-- Settings -->
    <NuxtLink
      to="/zipcode/settings"
      aria-label="Settings"
      class="grid place-items-center w-40 h-40 rounded-12 border"
      style="border-color: var(--zip-border); background: var(--zip-surface)"
    >
      <SvgIcon
        name="gear"
        class="w-18 h-18"
        style="color: var(--zip-text-muted)"
      />
    </NuxtLink>
  </div>
</template>
