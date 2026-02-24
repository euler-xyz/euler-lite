<script setup lang="ts">
import { useAccount } from '@wagmi/vue'
import { getSubAccountIndex } from '~/entities/account'

const { isConnected, address } = useAccount()
const { borrowPositions, isPositionsLoaded, portfolioAddress } = useEulerAccount()
const { isReady } = useVaults()

const ownerAddress = computed(() => portfolioAddress.value || address.value || '')

const sortedBorrowPositions = computed(() => {
  if (!ownerAddress.value) return borrowPositions.value
  return [...borrowPositions.value].sort((a, b) => {
    const indexA = getSubAccountIndex(ownerAddress.value, a.subAccount)
    const indexB = getSubAccountIndex(ownerAddress.value, b.subAccount)
    return indexA - indexB
  })
})
</script>

<template>
  <div class="flex flex-col flex-1">
    <div
      v-if="isConnected && (!isPositionsLoaded || (!isReady && sortedBorrowPositions.length === 0))"
      class="flex flex-1 justify-center items-center py-48"
    >
      <UiLoader class="text-content-tertiary" />
    </div>

    <div
      v-else-if="sortedBorrowPositions.length === 0"
      class="flex flex-1 justify-center items-center py-48"
    >
      <div class="flex flex-col gap-8 items-center text-content-tertiary">
        <div class="flex w-48 h-48 justify-center items-center rounded-12 bg-surface-secondary">
          <SvgIcon name="search" />
        </div>
        <template v-if="isConnected">
          You don't have positions yet
        </template>
        <template v-else>
          Connect your wallet to see your positions
        </template>
      </div>
    </div>

    <template v-else>
      <!-- Column headers -->
      <div class="sticky top-[72px] z-10 grid items-center gap-x-16 pt-16 py-8 px-20 bg-surface border-b border-line-default text-content-tertiary text-p3 mobile:!hidden grid-cols-[2fr_repeat(5,1fr)]">
        <div class="pl-[42px]">
          Pair
        </div>
        <div>Net APY</div>
        <div>ROE</div>
        <div>Net asset value</div>
        <div>Debt</div>
        <div>Health</div>
      </div>
      <PortfolioList
        :items="sortedBorrowPositions"
        type="borrow"
      />
      <div
        v-if="!isReady"
        class="flex justify-center items-center py-12"
      >
        <UiLoader class="text-content-tertiary" />
      </div>
    </template>
  </div>
</template>
