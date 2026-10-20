import { shallowReactive } from 'vue'
import type { Account, IHasVaultAddress } from '@eulerxyz/euler-v2-sdk'

type PlanningAccount = Account<IHasVaultAddress>
interface Confirmation {
  block: bigint
  waitUntilIndexed: () => Promise<void>
  indexed?: Promise<void>
}

// A confirmation invalidates every pre-confirmation account on that chain,
// including in-flight V3 reads and batch/portfolio fallbacks in this session.
const confirmations = shallowReactive(new Map<number, Confirmation>())
const accountConfirmations = new WeakMap<PlanningAccount, Confirmation>()

export const requireFreshPlanningAccount = (
  chainId: number,
  block: bigint,
  waitUntilIndexed: () => Promise<void>,
) => {
  const previous = confirmations.get(chainId)
  const confirmation = previous && block < previous.block ? previous : { block, waitUntilIndexed }
  confirmations.set(chainId, confirmation)
  return () => waitForIndexing(confirmation)
}

const waitForIndexing = (confirmation: Confirmation): Promise<void> => {
  confirmation.indexed ??= confirmation.waitUntilIndexed().catch((error) => {
    // A later user refresh can retry a failed/lagging indexer.
    confirmation.indexed = undefined
    throw error
  })
  return confirmation.indexed
}

export const isPlanningAccountCurrent = (account: PlanningAccount | undefined): account is PlanningAccount => {
  if (!account) return false
  const confirmation = confirmations.get(account.chainId)
  return !confirmation || accountConfirmations.get(account) === confirmation
}

export const assertPlanningAccountCurrent = (account: PlanningAccount) => {
  if (!isPlanningAccountCurrent(account)) {
    throw new Error('Account is updating after your transaction. Please try again shortly.')
  }
}

/** Read through the on-chain SDK only; a fast/display result must never be stamped here. */
export const readFreshPlanningAccount = async (
  chainId: number,
  read: () => Promise<PlanningAccount>,
): Promise<PlanningAccount> => {
  const confirmation = confirmations.get(chainId)
  if (confirmation) await waitForIndexing(confirmation)
  const account = await read()
  if (confirmations.get(chainId) !== confirmation) {
    throw new Error('Account changed while refreshing. Please try again.')
  }
  if (account.chainId !== chainId) throw new Error('Account snapshot belongs to another chain')
  if (confirmation) accountConfirmations.set(account, confirmation)
  return account
}

/** A simulated layer inherits the confirmation of its real-state baseline. */
export const inheritPlanningAccountFreshness = (source: PlanningAccount, derived: PlanningAccount) => {
  const confirmation = accountConfirmations.get(source)
  if (confirmation && source.chainId === derived.chainId && source.owner.toLowerCase() === derived.owner.toLowerCase()) {
    accountConfirmations.set(derived, confirmation)
  }
}
