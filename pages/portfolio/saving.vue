<script setup lang="ts">
import type { PortfolioSavingsPosition, VaultEntity } from '@eulerxyz/euler-v2-sdk'
import { getAssetUsdValueOrZero } from '~/utils/sdk-prices'

const { isConnected } = useWagmi()
const { isSpyMode } = useSpyMode()
const { depositPositions, removedDepositPositions, isDepositsLoaded } = useEulerAccount()
const { isReady } = useVaults()
const { isEarnVault } = useVaultRegistry()
const hasActiveSession = computed(() => isConnected.value || isSpyMode.value)

const displayedDepositPositions = computed(() => [
  ...removedDepositPositions.value,
  ...depositPositions.value,
])

const earnItems = computed(() => displayedDepositPositions.value.filter((p) => {
  const vault = p.vault
  return vault ? isEarnVault(vault.address) : false
}))
const lendItems = computed(() => displayedDepositPositions.value.filter((p) => {
  const vault = p.vault
  return vault ? !isEarnVault(vault.address) : false
}))

const sortByUsdValue = async (positions: PortfolioSavingsPosition<VaultEntity>[]): Promise<PortfolioSavingsPosition<VaultEntity>[]> => {
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

const sortedEarnItems = ref<PortfolioSavingsPosition<VaultEntity>[]>([])
const sortedLendItems = ref<PortfolioSavingsPosition<VaultEntity>[]>([])

watchEffect(async () => {
  sortedEarnItems.value = await sortByUsdValue(earnItems.value)
})
watchEffect(async () => {
  sortedLendItems.value = await sortByUsdValue(lendItems.value)
})

usePortfolioBatchScrollTarget(computed(() => [
  ...sortedEarnItems.value.map(position => position.subAccount),
  ...sortedLendItems.value.map(position => position.subAccount),
].join('|')))
</script>

<template>
  <div class="mx-16">
    <div class="flex justify-between items-center mb-8">
      <h3 class="text-h3 font-normal text-neutral-800">
        Curated lending
      </h3>
    </div>
    <p class="text-p2 text-neutral-500 mb-16">
      Supplied assets in curated vault strategies.
    </p>
    <div class="flex flex-1 p-8 rounded-12 mb-16 border border-line-default bg-card">
      <div
        v-if="hasActiveSession && (!isDepositsLoaded || (!isReady && earnItems.length === 0))"
        class="flex flex-1 justify-center items-center"
      >
        <UiLoader class="text-neutral-500 my-8" />
      </div>
      <div
        v-else-if="earnItems.length === 0"
        class="flex flex-1 justify-center items-center"
      >
        <PortfolioEmptyState
          :active="hasActiveSession"
          active-text="You don't have deposit positions yet"
          inactive-text="Connect your wallet to see your deposit positions"
        />
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
      Assets supplied to Euler vaults.
    </p>
    <div class="flex flex-1 p-8 rounded-12 border border-line-default bg-card">
      <div
        v-if="hasActiveSession && (!isDepositsLoaded || !isReady)"
        class="flex flex-1 justify-center items-center"
      >
        <UiLoader class="text-neutral-500 my-8" />
      </div>
      <div
        v-else-if="lendItems.length === 0"
        class="flex flex-1 justify-center items-center"
      >
        <PortfolioEmptyState
          :active="hasActiveSession"
          active-text="You don't have deposit positions yet"
          inactive-text="Connect your wallet to see your deposit positions"
        />
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
