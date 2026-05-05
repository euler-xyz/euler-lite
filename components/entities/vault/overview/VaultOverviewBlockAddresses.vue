<script setup lang="ts">
import type { EVault } from '~/entities/vault'
import { getExplorerLink } from '~/utils/block-explorer'
import { getSpecialAddressLabel } from '~/utils/special-addresses'
import { getVaultHookTarget } from '~/utils/vault-hooks'

const { vault } = defineProps<{ vault: EVault }>()

const { chainId } = useEulerAddresses()

// "Borrowable" = the vault has at least one collateral configured to allow
// borrowing. Read from the vault's own LTV table rather than `borrowList`
// membership so unverified (off-label) borrow vaults still surface their
// debt-token / fee-receiver / oracle addresses.
const isBorrowable = computed(() =>
  vault.collateralLTVs.some(ltv => ltv.borrowLTV > 0n),
)

const interestRateModelAddress = computed(() =>
  vault.interestRateModel.address,
)

const vaultAddresesInfo = computed(() => {
  const baseAddresses: Array<{ title: string, address?: string }> = [
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
        address: vault.fees.governorFeeReceiver,
      },
      {
        title: `Oracle router`,
        address: vault.oracle.oracle,
      },
      {
        title: `Unit of account`,
        address: vault.unitOfAccount?.address,
      },
      {
        title: `Interest rate model`,
        address: interestRateModelAddress.value,
      },
    )
  }

  baseAddresses.push(
    {
      title: `Hook target`,
      address: getVaultHookTarget(vault),
    },
  )

  return baseAddresses.filter((item): item is { title: string, address: string } => Boolean(item.address))
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
  <div class="bg-surface-secondary rounded-xl flex flex-col gap-24 p-24 shadow-card">
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
        <template
          v-if="infoItem.title === 'Unit of account'"
          #label
        >
          <span class="flex items-center gap-4">
            Unit of account
            <UiFootnote
              title="Unit of Account"
              text="The reference currency used to denominate prices for LTV and health calculations in this vault. Typically USD or ETH. All collateral and debt values are converted to this unit when determining account health."
              class="[--ui-footnote-icon-color:var(--text-muted)] hover:[--ui-footnote-icon-color:var(--text-secondary)]"
            />
          </span>
        </template>
        <div class="flex gap-4 items-center">
          <NuxtLink
            :to="getExplorerAddressLink(infoItem.address)"
            class="text-accent-600 underline cursor-pointer hover:text-accent-500"
            target="_blank"
          >
            {{ getSpecialAddressLabel(infoItem.address) || shortenAddress(infoItem.address) }}
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
