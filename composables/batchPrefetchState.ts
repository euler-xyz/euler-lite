import type { Account, IHasVaultAddress, SlotHints } from '@eulerxyz/euler-v2-sdk'

/**
 * Form-load accounts the batch builder can safely reuse on the first add.
 *
 * This module deliberately has no composable dependencies. Account, wallet, and
 * batch composables import each other for their simulated-state overlays, so a
 * small neutral registry keeps the prefetch hand-off free of another import
 * cycle.
 *
 * Both accounts are stored *pre-overlay* — they are written by the loaders
 * (`useFreshAccount`, `useEulerAccount`), never read back off the layer-aware
 * `usePlanAccount` / `useEulerAccount().portfolio` computeds. That matters:
 * those computeds return the active batch layer's *simulated* account when a
 * layer is active, which must never become the batch's own layer 0. Consumers
 * still have to validate chain + owner before reuse (see `isAccountForContext`
 * in `useTxBatch`) because a wallet or chain switch can land before the
 * matching loader run replaces these.
 *
 * Slot hints are safe to share independently: ERC20 storage-slot indices are
 * owner- and spender-agnostic, and the registry scopes them by chain. Keeping
 * the handoff here also avoids relying on the SDK module cache being shared
 * across separately bundled form and batch call paths.
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

/**
 * Drops prefetched state. Production account resets flow through the owning
 * loaders (`useFreshAccount.reset`, `useEulerAccount.resetLoadingState`); this
 * exists so tests can isolate module state between cases.
 */
export const resetBatchPrefetchState = () => {
  planningAccount = undefined
  baseAccount = undefined
  slotHintsByChain.clear()
}
