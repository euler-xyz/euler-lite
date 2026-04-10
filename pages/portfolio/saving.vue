<script setup lang="ts">
import { useAccount } from '@wagmi/vue'
import type { AccountDepositPosition } from '~/entities/account'
import { getAssetUsdValueOrZero } from '~/services/pricing/priceProvider'

const { isConnected } = useAccount()
const { depositPositions, isDepositsLoaded } = useEulerAccount()
const { isReady } = useVaults()
const { isEarnVault } = useVaultRegistry()

const earnItems = computed(() => depositPositions.value.filter(p => isEarnVault(p.vault.address)))
const lendItems = computed(() => depositPositions.value.filter(p => !isEarnVault(p.vault.address)))

const sortByUsdValue = async (positions: AccountDepositPosition[]): Promise<AccountDepositPosition[]> => {
  if (positions.length <= 1) return positions
  const withValues = await Promise.all(
    positions.map(async p => ({
      position: p,
      usdValue: await getAssetUsdValueOrZero(p.assets, p.vault, 'off-chain'),
    })),
  )
  return withValues
    .sort((a, b) => b.usdValue - a.usdValue)
    .map(item => item.position)
}

const sortedEarnItems = ref<AccountDepositPosition[]>([])
const sortedLendItems = ref<AccountDepositPosition[]>([])

watchEffect(async () => {
  sortedEarnItems.value = await sortByUsdValue(earnItems.value)
})
watchEffect(async () => {
  sortedLendItems.value = await sortByUsdValue(lendItems.value)
})
</script>

<template>
  <div class="mx-16">
    <div class="flex justify-between items-center mb-8">
      <h3 class="text-h3 font-normal text-neutral-800">
        Managed lending
      </h3>
    </div>
    <p class="text-p2 text-neutral-500 mb-16">
      Passive yield earned across professionally curated strategies.
    </p>
    <div class="flex flex-1 p-8 rounded-12 mb-16 border border-line-default bg-card">
      <div
        v-if="isConnected && (!isDepositsLoaded || (!isReady && earnItems.length === 0))"
        class="flex flex-1 justify-center items-center"
      >
        <UiLoader class="text-neutral-500 my-8" />
      </div>
      <div
        v-else-if="earnItems.length === 0"
        class="flex flex-1 justify-center items-center"
      >
        <div class="flex flex-col gap-8 items-center text-neutral-500 py-32">
          <div class="flex w-48 h-48 justify-center items-center rounded-12 bg-neutral-100">
            <SvgIcon name="search" />
          </div>
          <template v-if="isConnected">
            You don't have savings yet
          </template>
          <template v-else>
            Connect your wallet to see your savings
          </template>
        </div>
      </div>
      <div
        v-else
        class="flex-1"
      >
        <PortfolioList
          :items="sortedEarnItems"
          type="earn"
        />
        <div
          v-if="!isReady"
          class="flex justify-center items-center mt-12"
        >
          <UiLoader class="text-neutral-500" />
        </div>
      </div>
    </div>

    <div class="flex justify-between items-center mb-8">
      <h3 class="text-h3 font-normal text-neutral-800">
        Direct lending
      </h3>
    </div>
    <p class="text-p2 text-neutral-500 mb-16">
      Yield earned by lending assets directly to borrowers.
    </p>
    <div class="flex flex-1 p-8 rounded-12 border border-line-default bg-card">
      <div
        v-if="isConnected && (!isDepositsLoaded || !isReady)"
        class="flex flex-1 justify-center items-center"
      >
        <UiLoader class="text-neutral-500 my-8" />
      </div>
      <div
        v-else-if="lendItems.length === 0"
        class="flex flex-1 justify-center items-center"
      >
        <div class="flex flex-col gap-8 items-center text-neutral-500 py-32">
          <div class="flex w-48 h-48 justify-center items-center rounded-12 bg-neutral-100">
            <SvgIcon name="search" />
          </div>
          <template v-if="isConnected">
            You don't have savings yet
          </template>
          <template v-else>
            Connect your wallet to see your savings
          </template>
        </div>
      </div>
      <div
        v-else
        class="flex-1"
      >
        <PortfolioList
          :items="sortedLendItems"
          type="lend"
        />
      </div>
    </div>
  </div>
</template>
