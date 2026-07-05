<script setup lang="ts">
import type { EulerEarn } from '@eulerxyz/euler-v2-sdk'
import { getExplorerLink } from '~/utils/block-explorer'
import { getSpecialAddressLabel } from '~/utils/special-addresses'
import { shortenAddress } from '~/utils/string-utils'

const { vault, defaultOpen = true } = defineProps<{ vault: EulerEarn, defaultOpen?: boolean }>()
const { chainId } = useEulerAddresses()

const vaultAddresesInfo = computed(() => ([
  {
    title: `${vault.asset.symbol} token`,
    address: vault.asset.address,
  },
  {
    title: `${vault.asset.symbol} vault`,
    address: vault.address,
  },
  {
    title: `Fee receiver`,
    address: vault.governance.feeReceiver,
  },
]))

const { copyToClipboard } = useClipboardCopy()

const onCopyClick = (address: string) => {
  copyToClipboard(address).catch(() => {})
}

const getExplorerAddressLink = (address: string) => getExplorerLink(address, chainId.value, true)
</script>

<template>
  <VaultOverviewAccordionSection
    title="Addresses"
    :default-open="defaultOpen"
    content-class="flex flex-col items-start gap-24"
  >
    <VaultOverviewLabelValue
      v-for="infoItem in vaultAddresesInfo"
      :key="infoItem.title"
      :label="infoItem.title"
      orientation="horizontal"
    >
      <div class="flex gap-4 items-center">
        <NuxtLink
          :to="getExplorerAddressLink(infoItem.address)"
          class="text-accent-600 underline cursor-pointer hover:text-accent-500"
          target="_blank"
        >
          {{ getSpecialAddressLabel(infoItem.address) || shortenAddress(infoItem.address) }}
        </NuxtLink>
        <button
          class="text-neutral-400 cursor-pointer outline-none hover:text-neutral-600 active:text-neutral-700"
          @click="onCopyClick(infoItem.address)"
        >
          <SvgIcon
            class="!w-18 !h-18"
            name="copy"
          />
        </button>
      </div>
    </VaultOverviewLabelValue>
  </VaultOverviewAccordionSection>
</template>
