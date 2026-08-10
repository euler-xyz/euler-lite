import { encodeFunctionData, type Address, type Hex } from 'viem'
import { flattenBatchEntries } from '@eulerxyz/euler-v2-sdk'
import type { EVCBatchItem, TransactionPlan } from '@eulerxyz/euler-v2-sdk'

export type PlanCall = {
  to: Address
  data: Hex
  value: bigint
}

/** Minimal SDK surface needed to encode a plan — keeps tests dependency-free. */
export type PlanEncodingSdk = {
  deploymentService: {
    getDeployment: (chainId: number) => { addresses: { coreAddrs: { evc?: string } } }
  }
  executionService: {
    encodeBatch: (items: EVCBatchItem[]) => Hex
  }
}

export class PlanNotBundleableError extends Error {
  constructor(reason: string) {
    super(`Transaction plan cannot be bundled into a single submission: ${reason}`)
    this.name = 'PlanNotBundleableError'
  }
}

/**
 * Convert a resolved transaction plan into the raw `{ to, data, value }`
 * calls it would send, in order — the payload for an EIP-5792
 * `wallet_sendCalls` bundle.
 *
 * Throws PlanNotBundleableError for plans that cannot be expressed as a
 * static call list: unresolved approval requirements, permit2 signatures
 * (nothing to encode before signing), and CoW swap items (submitted to an
 * order book, not the chain). Callers treat that as "execute sequentially
 * instead".
 */
export const transactionPlanToCalls = (
  plan: TransactionPlan,
  sdk: PlanEncodingSdk,
  chainId: number,
): PlanCall[] => {
  const calls: PlanCall[] = []

  for (const item of plan) {
    if (item.type === 'requiredApproval') {
      if (!item.resolved) {
        throw new PlanNotBundleableError('approval requirement is unresolved')
      }
      for (const resolved of item.resolved) {
        if (resolved.type !== 'approve') {
          throw new PlanNotBundleableError('permit2 signatures cannot be embedded in a call bundle')
        }
        calls.push({ to: resolved.token, data: resolved.data, value: 0n })
      }
      continue
    }

    if (item.type === 'evcBatch') {
      const items = flattenBatchEntries(item.items)
      const evcAddress = sdk.deploymentService.getDeployment(chainId).addresses.coreAddrs.evc
      if (!evcAddress) {
        throw new PlanNotBundleableError(`EVC address unavailable for chain ${chainId}`)
      }
      calls.push({
        to: evcAddress as Address,
        data: sdk.executionService.encodeBatch(items),
        value: items.reduce((sum, entry) => sum + entry.value, 0n),
      })
      continue
    }

    if (item.type === 'contractCall') {
      calls.push({
        to: item.to,
        data: encodeFunctionData({
          abi: item.abi,
          functionName: item.functionName,
          args: item.args,
        }),
        value: item.value,
      })
      continue
    }

    throw new PlanNotBundleableError(`unsupported plan item type "${item.type}"`)
  }

  return calls
}

/**
 * Whether a resolved plan would actually submit as one EIP-5792 bundle:
 * every item is expressible as a static call AND there are at least two
 * calls (a single call gains nothing from bundling). Mirrors the execution
 * gate in useEulerTx without encoding anything — use for display decisions.
 */
export const isPlanBundleable = (plan: TransactionPlan): boolean => {
  let callCount = 0

  for (const item of plan) {
    if (item.type === 'requiredApproval') {
      if (!item.resolved) return false
      for (const resolved of item.resolved) {
        if (resolved.type !== 'approve') return false
        callCount++
      }
      continue
    }
    if (item.type === 'evcBatch' || item.type === 'contractCall') {
      callCount++
      continue
    }
    return false
  }

  return callCount >= 2
}
