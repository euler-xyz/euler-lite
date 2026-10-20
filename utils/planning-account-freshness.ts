import { shallowReactive } from 'vue'
import { getAddress } from 'viem'
import type { Account, IHasVaultAddress } from '@eulerxyz/euler-v2-sdk'
import { SUBGRAPH_BLOCK_CATCHUP_RETRY_BACKOFF_MS } from '~/entities/tuning-constants'

type PlanningAccount = Account<IHasVaultAddress>
interface Confirmation {
  block: bigint
  waitUntilIndexed: () => Promise<void>
  indexed?: Promise<void>
  retryAfter?: number
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
  if (confirmation.retryAfter !== undefined && Date.now() >= confirmation.retryAfter) {
    confirmation.indexed = undefined
    confirmation.retryAfter = undefined
  }
  confirmation.indexed ??= confirmation.waitUntilIndexed().catch((error) => {
    // Repeated refreshes share this failure briefly; a later refresh can retry.
    confirmation.retryAfter = Date.now() + SUBGRAPH_BLOCK_CATCHUP_RETRY_BACKOFF_MS
    throw error
  })
  return confirmation.indexed
}

export const isPlanningAccountCurrent = (account: PlanningAccount | undefined): account is PlanningAccount => {
  if (!account) return false
  const confirmation = confirmations.get(account.chainId)
  return !confirmation || accountConfirmations.get(account) === confirmation
}

/** Select only snapshots belonging to the active wallet and chain. */
export const isPlanningAccountForContext = (
  account: PlanningAccount | undefined,
  owner: string | undefined,
  chainId: number | undefined,
): account is PlanningAccount => {
  if (!owner || !chainId || !isPlanningAccountCurrent(account) || account.chainId !== chainId) return false
  try {
    return getAddress(account.owner) === getAddress(owner)
  }
  catch {
    return false
  }
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
