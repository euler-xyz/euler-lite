<script setup lang="ts">
import { getExplorerLink } from '~/utils/block-explorer'
import { getSpecialAddressLabel } from '~/utils/special-addresses'
import { shortenAddress } from '~/utils/string-utils'

const { address, checkSafe = false } = defineProps<{
  address: string
  /**
   * Probe the address for being a Safe multisig and render the badge.
   * Enable only for governance-related addresses — token/vault/IRM rows are
   * known contracts and would just waste probes.
   */
  checkSafe?: boolean
}>()

const { chainId } = useEulerAddresses()
const { copyToClipboard } = useClipboardCopy()

const explorerLink = computed(() => getExplorerLink(address, chainId.value, true))
const displayLabel = computed(() => getSpecialAddressLabel(address) || shortenAddress(address))

const onCopyClick = () => {
  copyToClipboard(address).catch(() => {})
}
</script>

<template>
  <div class="flex gap-4 items-center">
    <SafeAccountBadge
      v-if="checkSafe"
      :address="address"
    />
    <NuxtLink
      :to="explorerLink"
      class="text-accent-600 underline cursor-pointer hover:text-accent-500"
      target="_blank"
    >
      {{ displayLabel }}
    </NuxtLink>
    <button
      class="text-content-muted cursor-pointer outline-none hover:text-content-secondary active:text-content-primary"
      @click="onCopyClick"
    >
      <SvgIcon
        class="!w-18 !h-18"
        name="copy"
      />
    </button>
  </div>
</template>
