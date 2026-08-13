import type { TransactionPlan } from '@eulerxyz/euler-v2-sdk'
import type { BatchEntryExternalTx } from '~/composables/useTxBatch'
import { transactionPlanToCalls, type PlanEncodingSdk } from '~/utils/transaction-plan-calls'

export interface BatchReviewCalldataEntry {
  to: string
  data: string
  value: string
}

interface BuildBatchReviewCalldataOptions {
  plan: TransactionPlan
  before?: readonly BatchEntryExternalTx[]
  after?: readonly BatchEntryExternalTx[]
  sdk: PlanEncodingSdk
  chainId: number
}

const plainCallToCalldata = (call: BatchEntryExternalTx): BatchReviewCalldataEntry => ({
  to: call.to,
  data: call.data,
  value: (call.value ?? 0n).toString(),
})

/** Build the exact ordered call vector shown by Copy calldata. */
export const buildBatchReviewCalldata = ({
  plan,
  before = [],
  after = [],
  sdk,
  chainId,
}: BuildBatchReviewCalldataOptions): BatchReviewCalldataEntry[] => {
  const out = before.map(plainCallToCalldata)
  out.push(...transactionPlanToCalls(plan, sdk, chainId).map(call => ({
    to: call.to,
    data: call.data,
    value: call.value.toString(),
  })))
  out.push(...after.map(plainCallToCalldata))
  return out
}
