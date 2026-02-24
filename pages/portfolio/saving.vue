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
  <div class="flex flex-col flex-1">
    <!-- Managed lending section -->
    <div>
      <div class="px-20 py-16 border-b border-line-default">
        <h2 class="text-h2 text-content-primary mb-4">
          Managed lending
        </h2>
        <p class="text-p3 text-content-tertiary">
          Savings deposited into curated earn vaults that earn yield. Not used as collateral to back a borrow position.
        </p>
      </div>

      <div
        v-if="isConnected && (!isDepositsLoaded || (!isReady && earnItems.length === 0))"
        class="flex justify-center items-center py-32"
      >
        <UiLoader class="text-content-tertiary" />
      </div>
      <div
        v-else-if="earnItems.length === 0"
        class="flex justify-center items-center py-32"
      >
        <div class="flex flex-col gap-8 items-center text-content-tertiary">
          <div class="flex w-48 h-48 justify-center items-center rounded-12 bg-surface-secondary">
            <SvgIcon name="search" />
          </div>
          <template v-if="isConnected">
            You don't have managed lending positions yet
          </template>
          <template v-else>
            Connect your wallet to see your positions
          </template>
        </div>
      </div>
      <template v-else>
        <!-- Column headers -->
        <div class="sticky top-[72px] z-10 grid items-center gap-x-16 pt-16 py-8 px-20 bg-surface border-b border-line-default text-content-tertiary text-p3 mobile:!hidden grid-cols-[2fr_repeat(3,1fr)]">
          <div class="pl-[42px]">
            Asset
          </div>
          <div>Supply APY</div>
          <div>Supply value</div>
          <div>Projected/month</div>
        </div>
        <PortfolioList
          :items="sortedEarnItems"
          type="earn"
        />
      </template>
    </div>

    <!-- Direct lending section -->
    <div class="border-t border-line-default">
      <div class="px-20 py-16 border-b border-line-default">
        <h2 class="text-h2 text-content-primary mb-4">
          Direct lending
        </h2>
        <p class="text-p3 text-content-tertiary">
          Supply-only deposits on your main account that earn yield. Not used as collateral to back a borrow position.
        </p>
      </div>

      <div
        v-if="isConnected && (!isDepositsLoaded || !isReady)"
        class="flex justify-center items-center py-32"
      >
        <UiLoader class="text-content-tertiary" />
      </div>
      <div
        v-else-if="lendItems.length === 0"
        class="flex justify-center items-center py-32"
      >
        <div class="flex flex-col gap-8 items-center text-content-tertiary">
          <div class="flex w-48 h-48 justify-center items-center rounded-12 bg-surface-secondary">
            <SvgIcon name="search" />
          </div>
          <template v-if="isConnected">
            You don't have direct lending positions yet
          </template>
          <template v-else>
            Connect your wallet to see your positions
          </template>
        </div>
      </div>
      <template v-else>
        <!-- Column headers -->
        <div class="sticky top-[72px] z-10 grid items-center gap-x-16 pt-16 py-8 px-20 bg-surface border-b border-line-default text-content-tertiary text-p3 mobile:!hidden grid-cols-[2fr_repeat(3,1fr)]">
          <div class="pl-[42px]">
            Asset
          </div>
          <div>Supply APY</div>
          <div>Supply value</div>
          <div>Projected/month</div>
        </div>
        <PortfolioList
          :items="sortedLendItems"
          type="lend"
        />
      </template>
    </div>
  </div>
</template>
