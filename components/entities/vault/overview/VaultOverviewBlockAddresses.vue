<script setup lang="ts">
import type { Vault } from '~/entities/vault'
import { getExplorerLink } from '~/utils/block-explorer'

const { vault } = defineProps<{ vault: Vault }>()

const { borrowList } = useVaults()
const { chainId } = useEulerAddresses()

const borrowCount = computed(() => {
  return borrowList.value.filter(pair => pair.borrow.address === vault.address).length
})

const isBorrowable = computed(() => borrowCount.value > 0)

const vaultAddresesInfo = computed(() => {
  const baseAddresses = [
    {
      title: `${vault.asset.symbol} token`,
      address: vault.asset.address,
    },
    {
      title: `${vault.asset.symbol} vault`,
      address: vault.address,
    },
  ]

  if (isBorrowable.value) {
    baseAddresses.push(
      {
        title: `${vault.asset.symbol} debt`,
        address: vault.dToken,
      },
    )
  }

  baseAddresses.push(
    {
      title: `Risk manager`,
      address: vault.governorAdmin,
    },
  )

  if (isBorrowable.value) {
    baseAddresses.push(
      {
        title: `Fee receiver`,
        address: vault.governorFeeReceiver,
      },
      {
        title: `Oracle router address`,
        address: vault.oracle,
      },
      {
        title: `Unit of account address`,
        address: vault.unitOfAccount,
      },
      {
        title: `Interest rate model address`,
        address: vault.interestRateModelAddress,
      },
    )
  }

  baseAddresses.push(
    {
      title: `Hook target`,
      address: vault.hookTarget,
    },
  )

  return baseAddresses
})

const shortenAddress = (address: string) => {
  return `${address.slice(0, 6)}...${address.slice(-4)}`
}

const onCopyClick = (address: string) => {
  navigator.clipboard.writeText(address)
}

const getExplorerAddressLink = (address: string) => getExplorerLink(address, chainId.value, true)
</script>

<template>
  <div class="flex flex-col gap-24 p-24 border-b border-line-default last:border-b-0">
    <p class="text-h3 text-content-primary">
      Addresses
    </p>
    <div class="flex flex-col items-start gap-24">
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
            {{ shortenAddress(infoItem.address) }}
          </NuxtLink>
          <button
            class="text-content-muted cursor-pointer outline-none hover:text-content-secondary active:text-content-primary"
            @click="onCopyClick(infoItem.address)"
          >
            <SvgIcon
              class="!w-18 !h-18"
              name="copy"
            />
          </button>
        </div>
      </VaultOverviewLabelValue>
    </div>
  </div>
</template>
