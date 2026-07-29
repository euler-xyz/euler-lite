import type { Account, IHasVaultAddress, SlotHints } from '@eulerxyz/euler-v2-sdk'

/**
 * Form-load data that the batch builder can safely reuse on the first add.
 *
 * This module deliberately has no composable dependencies. Account, wallet, and
 * batch composables import each other for their simulated-state overlays, so a
 * small neutral registry keeps the prefetch hand-off free of another import
 * cycle.
 */
let planningAccount: Account<IHasVaultAddress> | undefined
let baseAccount: Account<IHasVaultAddress> | undefined
const slotHintsByChain = new Map<number, SlotHints>()

export const setBatchPrefetchedPlanningAccount = (
  account: Account<IHasVaultAddress> | undefined,
) => {
  planningAccount = account
}

export const getBatchPrefetchedPlanningAccount = () => planningAccount

export const setBatchPrefetchedBaseAccount = (
  account: Account<IHasVaultAddress> | undefined,
) => {
  baseAccount = account
}

export const getBatchPrefetchedBaseAccount = () => baseAccount

export const mergeBatchPrefetchedSlotHints = (
  chainId: number,
  slotHints: SlotHints,
) => {
  slotHintsByChain.set(chainId, {
    ...slotHintsByChain.get(chainId),
    ...slotHints,
  })
}

export const getBatchPrefetchedSlotHints = (chainId: number): SlotHints => ({
  ...slotHintsByChain.get(chainId),
})

export const resetBatchPrefetchState = () => {
  planningAccount = undefined
  baseAccount = undefined
  slotHintsByChain.clear()
}
