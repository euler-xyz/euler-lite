<script setup lang="ts">
import type { PortfolioBorrowPosition, PortfolioSavingsPosition, UserReward, VaultEntity } from '@eulerxyz/euler-v2-sdk'
import { isRenderablePortfolioBorrowPosition } from '~/utils/portfolioBorrowPosition'
import { getAddress } from 'viem'

defineProps<{
  type: 'lend' | 'borrow' | 'earn' | 'sdk-rewards'
  items: unknown[]
}>()

const { removedKeys } = useTxBatch()

const positionKey = (subAccount: string, vault: string) =>
  `${getAddress(subAccount).toLowerCase()}:${getAddress(vault).toLowerCase()}`

const getDepositPositionBaseKey = (position: PortfolioSavingsPosition<VaultEntity>) =>
  `${getAddress(position.subAccount).toLowerCase()}-${getAddress(position.position.vaultAddress).toLowerCase()}`

const isRemovedDepositPosition = (position: PortfolioSavingsPosition<VaultEntity>) =>
  removedKeys.value.has(positionKey(position.subAccount, position.position.vaultAddress))

const getDepositPositionKey = (position: PortfolioSavingsPosition<VaultEntity>) =>
  `${isRemovedDepositPosition(position) ? 'removed-' : ''}${getDepositPositionBaseKey(position)}`

const getBorrowCollateralAddresses = (position: PortfolioBorrowPosition<VaultEntity>): string[] => {
  const addresses = new Set<string>()
  const add = (address: string | undefined) => {
    if (!address) return
    addresses.add(getAddress(address).toLowerCase())
  }
  for (const address of position.collateralVaults ?? []) add(address)
  add(position.collateral?.vaultAddress)
  add(position.collateralVault?.address)
  return Array.from(addresses).sort()
}

const isRemovedBorrowPosition = (position: PortfolioBorrowPosition<VaultEntity>) => {
  const subAccount = getAddress(position.subAccount).toLowerCase()
  const borrowRemoved = removedKeys.value.has(`${subAccount}:${getAddress(position.borrow.vaultAddress).toLowerCase()}`)
  const collateralAddresses = getBorrowCollateralAddresses(position)
  return borrowRemoved
    && collateralAddresses.length > 0
    && collateralAddresses.every(vault => removedKeys.value.has(`${subAccount}:${vault}`))
}

const getBorrowPositionBaseKey = (position: PortfolioBorrowPosition<VaultEntity>) =>
  `${getAddress(position.subAccount).toLowerCase()}-${getAddress(position.borrow.vaultAddress).toLowerCase()}-${getBorrowCollateralAddresses(position)[0] ?? 'none'}`

const getBorrowPositionKey = (position: PortfolioBorrowPosition<VaultEntity>) =>
  `${isRemovedBorrowPosition(position) ? 'removed-' : ''}${getBorrowPositionBaseKey(position)}`
</script>

<template>
  <div
    class="flex flex-col gap-8"
    data-id="portfolio-list"
    :data-list="type"
    :data-count="items.length"
  >
    <template v-if="type === 'lend'">
      <PortfolioSavingItem
        v-for="(position) in items"
        :key="getDepositPositionKey(position as PortfolioSavingsPosition<VaultEntity>)"
        :position="position as PortfolioSavingsPosition<VaultEntity>"
      />
    </template>
    <template v-else-if="type === 'borrow'">
      <template
        v-for="position in items"
        :key="getBorrowPositionKey(position as PortfolioBorrowPosition<VaultEntity>)"
      >
        <PortfolioBorrowItem
          v-if="isRenderablePortfolioBorrowPosition(position as PortfolioBorrowPosition<VaultEntity>)"
          :position="position as PortfolioBorrowPosition<VaultEntity>"
        />
        <PortfolioUnsupportedBorrowItem
          v-else
          :position="position as PortfolioBorrowPosition<VaultEntity>"
        />
      </template>
    </template>
    <template v-else-if="type === 'earn'">
      <PortfolioEarnItem
        v-for="(position) in items"
        :key="getDepositPositionKey(position as PortfolioSavingsPosition<VaultEntity>)"
        :position="position as PortfolioSavingsPosition<VaultEntity>"
      />
    </template>
    <template v-else-if="type === 'sdk-rewards'">
      <PortfolioSdkRewardItem
        v-for="(reward, idx) in items"
        :key="`sdk-reward-${idx}`"
        :reward="reward as UserReward"
      />
    </template>
  </div>
</template>
