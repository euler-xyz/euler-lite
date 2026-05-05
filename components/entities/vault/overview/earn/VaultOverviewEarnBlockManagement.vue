<script setup lang="ts">
import type { EulerEarn } from '~/entities/vault'
import { formatTtl } from '~/utils/crypto-utils'
import { getExplorerLink } from '~/utils/block-explorer'
import { getSpecialAddressLabel } from '~/utils/special-addresses'

const { vault } = defineProps<{ vault: EulerEarn }>()
const { chainId } = useEulerAddresses()

const vaultAddressesInfo = computed(() => ([
  {
    title: `Owner`,
    address: vault.governance.owner,
  },
  {
    title: `Curator`,
    address: vault.governance.curator,
  },
  {
    title: `Guardian`,
    address: vault.governance.guardian,
  },
]))

const shortenAddress = (address: string) => {
  return `${address.slice(0, 6)}...${address.slice(-4)}`
}

const timelockDisplay = computed(() => {
  if (vault.governance.timelock === 0) {
    return '0 days'
  }

  const timelockInSeconds = vault.governance.timelock
  const timelockInDays = BigInt(Math.floor(timelockInSeconds / 86400))
  return formatTtl(timelockInDays)?.display || 'Unknown'
})

const onCopyClick = (address: string) => {
  navigator.clipboard.writeText(address)
}

const getExplorerAddressLink = (address: string) => getExplorerLink(address, chainId.value, true)
</script>

<template>
  <div class="bg-surface-secondary rounded-xl flex flex-col gap-24 p-24 shadow-card">
    <p class="text-h3 text-content-primary">
      Management
    </p>
    <div class="flex flex-col items-start gap-24">
      <VaultOverviewLabelValue
        v-for="infoItem in vaultAddressesInfo"
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
      <VaultOverviewLabelValue
        label="Timelock"
        orientation="horizontal"
      >
        <span class="pr-[22px]">{{ timelockDisplay }}</span>
      </VaultOverviewLabelValue>
    </div>
  </div>
</template>
