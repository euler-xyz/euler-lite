<script setup lang="ts">
import { getSubAccountId as getSubAccountIndex } from '@eulerxyz/euler-v2-sdk'
import { getAddress } from 'viem'

const { isConnected, address } = useWagmi()
const { isSpyMode } = useSpyMode()
const { borrowPositions, removedBorrowPositions, isPositionsLoaded, portfolioAddress } = useEulerAccount()
const { isReady } = useVaults()

const hasActiveSession = computed(() => isConnected.value || isSpyMode.value)
const ownerAddress = computed(() => portfolioAddress.value || address.value || '')

const sortedBorrowPositions = computed(() => {
  const positions = [...removedBorrowPositions.value, ...borrowPositions.value]
  if (!ownerAddress.value) return positions
  return positions.sort((a, b) => {
    const indexA = getSubAccountIndex(getAddress(ownerAddress.value), getAddress(a.subAccount))
    const indexB = getSubAccountIndex(getAddress(ownerAddress.value), getAddress(b.subAccount))
    return indexA - indexB
  })
})

const borrowPositionScrollRenderKey = computed(() =>
  sortedBorrowPositions.value.map(position => [
    position.subAccount,
    position.borrow?.vaultAddress,
    position.collateral?.vaultAddress,
    position.collateralVault?.address,
    ...(position.collateralVaults ?? []),
  ].filter(Boolean).join(':')).join('|'),
)

usePortfolioBatchScrollTarget(computed(() =>
  borrowPositionScrollRenderKey.value,
))
</script>

<template>
  <div class="mx-16">
    <div class="flex justify-between items-center mb-8">
      <h3 class="text-h3 font-normal text-neutral-800">
        Borrow positions
      </h3>
    </div>
    <p class="text-p2 text-neutral-500 mb-16">
      Active loans backed by your supplied collateral.
    </p>
    <div
      class="flex flex-1 p-8 rounded-12 border border-line-default bg-card"
    >
      <div
        v-if="hasActiveSession && (!isPositionsLoaded || (!isReady && sortedBorrowPositions.length === 0))"
        class="flex flex-1 justify-center items-center"
      >
        <UiLoader class="text-neutral-500 my-8" />
      </div>

      <div
        v-else-if="sortedBorrowPositions.length === 0"
        class="flex flex-1 justify-center items-center"
      >
        <div class="flex flex-col gap-8 items-center text-neutral-500 py-32">
          <div class="flex w-48 h-48 justify-center items-center rounded-12 bg-neutral-100">
            <SvgIcon name="search" />
          </div>
          <template v-if="hasActiveSession">
            You don't have positions yet
          </template>
          <template v-else>
            Connect your wallet to see your positions
          </template>
        </div>
      </div>

      <div
        v-else
        class="flex-1"
      >
        <PortfolioList
          :items="sortedBorrowPositions"
          type="borrow"
        />
        <div
          v-if="!isReady"
          class="flex justify-center items-center mt-12"
        >
          <UiLoader class="text-neutral-500" />
        </div>
      </div>
    </div>
  </div>
</template>
