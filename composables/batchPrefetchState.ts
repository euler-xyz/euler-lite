import type { Account, IHasVaultAddress } from '@eulerxyz/euler-v2-sdk'

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
 * Slot hints are deliberately *not* mirrored here: the SDK's `fetchErc20SlotHints`
 * already memoises module-scope by `chainId:token`, so once any form has primed a
 * token the batch's own probe short-circuits to a Map lookup with no RPC.
 */
let planningAccount: Account<IHasVaultAddress> | undefined
let baseAccount: Account<IHasVaultAddress> | undefined

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

/**
 * Drops both prefetched accounts. Production resets flow through the owning
 * loaders (`useFreshAccount.reset`, `useEulerAccount.resetLoadingState`); this
 * exists so tests can isolate module state between cases.
 */
export const resetBatchPrefetchState = () => {
  planningAccount = undefined
  baseAccount = undefined
}
