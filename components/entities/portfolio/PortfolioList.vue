<script setup lang="ts">
import type { PortfolioBorrowPosition, PortfolioSavingsPosition, VaultEntity } from '@eulerxyz/euler-v2-sdk'
import type { UserReward } from '~/entities/reward-campaign'
import { isRenderablePortfolioBorrowPosition } from '~/utils/portfolioBorrowPosition'
import { getAddress } from 'viem'

const props = defineProps<{
  type: 'lend' | 'borrow' | 'earn' | 'sdk-rewards'
  items: unknown[]
}>()

// TEMP DIAGNOSTIC (remove): log borrow positions that fall back to the
// "Unknown collateral" unsupported renderer, to see whether the collateral
// vault is missing entirely or present-but-unresolved.
watch(() => props.items, (items) => {
  if (props.type !== 'borrow') return
  for (const p of items as PortfolioBorrowPosition<VaultEntity>[]) {
    if (isRenderablePortfolioBorrowPosition(p)) continue
    const collateralVault = p.collateralVault as { address?: string } | undefined
    // eslint-disable-next-line no-console
    console.log('[UNSUPPORTED-BORROW]', JSON.stringify({
      subAccount: p.subAccount,
      borrowVault: p.borrowVault?.address,
      borrowAsset: p.borrowVault?.asset?.symbol,
      collateralVaultMissing: !collateralVault,
      collateralVaultAddress: collateralVault?.address,
      collateralVaults: p.collateralVaults,
      collaterals: (p.collaterals ?? []).map(c => ({
        vaultAddress: c.vaultAddress,
        hasVaultInstance: !!c.vault,
        vaultInstanceAddress: c.vault?.address,
        assets: String(c.assets),
      })),
    }, null, 2))
  }
}, { immediate: true })

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
