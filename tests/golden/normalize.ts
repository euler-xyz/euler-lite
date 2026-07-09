import { encodeFunctionData, getAddress, type Address, type Hex } from 'viem'
import type { TransactionPlan, EVCBatchEntry, EVCBatchItem } from '@eulerxyz/euler-v2-sdk'
import { flattenBatchEntries } from '@eulerxyz/euler-v2-sdk'

// --- Imported lazily so the legacy types live in the legacy worktree ---
// (Both sides describe the same shape: target/onBehalfOfAccount/value/data
// EVC batch items.)
type EVCCall = {
  targetContract: Address
  onBehalfOfAccount: Address
  value: bigint
  data: Hex
}

export type CanonicalTx = {
  to: Address
  data: Hex
  value: string // serialize bigint to string for stable JSON
  // For EVC-batch txs, the decoded inner batch is included so a diff
  // shows the structural change rather than just the encoded blob.
  evcBatch?: Array<{
    targetContract: Address
    onBehalfOfAccount: Address
    value: string
    data: Hex
    selector: Hex
  }>
}

const EVC_BATCH_ABI = [{
  type: 'function',
  name: 'batch',
  stateMutability: 'payable',
  inputs: [{
    name: 'items',
    type: 'tuple[]',
    components: [
      { name: 'targetContract', type: 'address' },
      { name: 'onBehalfOfAccount', type: 'address' },
      { name: 'value', type: 'uint256' },
      { name: 'data', type: 'bytes' },
    ],
  }],
  outputs: [],
}] as const

const normalizeEvcCall = (c: EVCCall) => ({
  targetContract: getAddress(c.targetContract),
  onBehalfOfAccount: getAddress(c.onBehalfOfAccount),
  value: c.value.toString(),
  data: c.data,
  selector: c.data.slice(0, 10) as Hex,
})

const encodeBatch = (items: EVCCall[]): Hex => encodeFunctionData({
  abi: EVC_BATCH_ABI,
  functionName: 'batch',
  args: [items],
})

/**
 * Reduce a legacy `TxPlan` to canonical {to, data, value} txs.
 * Each `TxStep` corresponds to one transaction; `evc-batch` steps are
 * encoded as `EVC.batch(items)` calldata.
 */
export function normalizeLegacyPlan(plan: {
  steps: Array<{
    type: string
    to: Address
    abi: readonly unknown[] | object
    functionName: string
    args: readonly unknown[]
    value?: bigint
  }>
}, evcAddress: Address): CanonicalTx[] {
  return plan.steps.map((step) => {
    if (step.type === 'evc-batch') {
      // args = [evcCalls]
      const calls = step.args[0] as EVCCall[]
      return {
        to: evcAddress,
        data: encodeBatch(calls),
        value: (step.value ?? 0n).toString(),
        evcBatch: calls.map(normalizeEvcCall),
      }
    }
    return {
      to: step.to,
      data: encodeFunctionData({
        abi: step.abi as never,
        functionName: step.functionName,
        args: step.args,
      }),
      value: (step.value ?? 0n).toString(),
    }
  })
}

/**
 * Reduce an SDK `TransactionPlan` (post-approval-expansion) to canonical txs.
 * Approval items become {to: token, data: approve(...), value: 0}.
 * EVC batch items become {to: evc, data: batch(items)}.
 * Permit2 sign items are excluded — they're off-chain signatures, not txs.
 */
export function normalizeSdkPlan(plan: TransactionPlan, evcAddress: Address): CanonicalTx[] {
  const txs: CanonicalTx[] = []
  for (const item of plan) {
    if (item.type === 'requiredApproval') {
      const resolved = item.resolved ?? []
      for (const r of resolved) {
        if (r.type === 'approve') {
          txs.push({
            to: r.token,
            data: r.data,
            value: '0',
          })
        }
        // permit2 sign items are off-chain — skip
      }
      continue
    }
    if (item.type === 'evcBatch') {
      const items = flattenBatchEntries(item.items as EVCBatchEntry[]) as EVCBatchItem[]
      txs.push({
        to: evcAddress,
        data: encodeBatch(items as EVCCall[]),
        value: items.reduce((sum, it) => sum + it.value, 0n).toString(),
        evcBatch: items.map(it => normalizeEvcCall(it as EVCCall)),
      })
      continue
    }
    if (item.type === 'contractCall') {
      txs.push({
        to: item.to,
        data: encodeFunctionData({
          abi: item.abi as never,
          functionName: item.functionName,
          args: item.args,
        }),
        value: item.value.toString(),
      })
      continue
    }
    // cowSwap items: out of scope for v1 golden tests
  }
  return txs
}
