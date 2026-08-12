import { flattenBatchEntries, isEVCBatchOperation, type EVCBatchItem, type TransactionPlan, type TransactionPlanPrepared } from '@eulerxyz/euler-v2-sdk'
import { toFunctionSelector } from 'viem'

export const REVIEWED_EXECUTION_UNAVAILABLE_ERROR
  = 'The reviewed transaction is unavailable. Close this review and try again.'

export const REVIEWED_EXECUTION_CHANGED_ERROR
  = 'The transaction changed while it was being refreshed. Close this review and try again.'

export const REVIEWED_BATCH_EXECUTION_CHANGED_ERROR
  = 'The batch changed after review. Close this review and review the final transaction again.'

const PYTH_UPDATE_SELECTOR = toFunctionSelector('function updatePriceFeeds(bytes[])')

const isPythUpdate = (item: Record<string, unknown>): boolean => {
  const data = typeof item.data === 'string' ? item.data : ''
  return data.slice(0, 10).toLowerCase() === PYTH_UPDATE_SELECTOR.toLowerCase()
}

const canonicalizePythUpdate = (item: Record<string, unknown>): Record<string, unknown> => {
  if (!isPythUpdate(item)) return item
  return {
    ...item,
    data: '__fresh_pyth_update__',
    value: '__fresh_pyth_fee__',
  }
}

const DYNAMIC_SIGNATURE_LENGTH_WORD = `${'0'.repeat(62)}41`
const PLACEHOLDER_SIGNATURE_DATA = '0'.repeat(65 * 2)

export type ReviewedSignaturePlaceholderCall = Pick<
  EVCBatchItem,
  'targetContract' | 'onBehalfOfAccount' | 'value' | 'data'
>

const signatureCallKey = (call: ReviewedSignaturePlaceholderCall): string => [
  call.targetContract.toLowerCase(),
  call.onBehalfOfAccount.toLowerCase(),
  call.value.toString(),
  call.data.toLowerCase(),
].join(':')

const canonicalizeReviewedSignature = (data: string): string => {
  const normalized = data.toLowerCase()
  let searchFrom = 0
  let result = normalized
  while (searchFrom < result.length) {
    const lengthWordIndex = result.indexOf(DYNAMIC_SIGNATURE_LENGTH_WORD, searchFrom)
    if (lengthWordIndex < 0) break
    const signatureStart = lengthWordIndex + DYNAMIC_SIGNATURE_LENGTH_WORD.length
    const signatureEnd = signatureStart + PLACEHOLDER_SIGNATURE_DATA.length
    if (result.slice(signatureStart, signatureEnd) === PLACEHOLDER_SIGNATURE_DATA) {
      result = `${result.slice(0, signatureStart)}__reviewed_signature__${result.slice(signatureEnd)}`
      searchFrom = signatureStart + '__reviewed_signature__'.length
    }
    else {
      searchFrom = signatureStart
    }
  }
  return result
}

const canonicalizeMatchingSignature = (reviewedData: string, candidateData: string): string => {
  const reviewed = reviewedData.toLowerCase()
  let candidate = candidateData.toLowerCase()
  if (reviewed.length !== candidate.length) return candidate
  let searchFrom = 0
  while (searchFrom < reviewed.length) {
    const lengthWordIndex = reviewed.indexOf(DYNAMIC_SIGNATURE_LENGTH_WORD, searchFrom)
    if (lengthWordIndex < 0) break
    const signatureStart = lengthWordIndex + DYNAMIC_SIGNATURE_LENGTH_WORD.length
    const signatureEnd = signatureStart + PLACEHOLDER_SIGNATURE_DATA.length
    if (reviewed.slice(signatureStart, signatureEnd) === PLACEHOLDER_SIGNATURE_DATA) {
      candidate = `${candidate.slice(0, signatureStart)}__reviewed_signature__${candidate.slice(signatureEnd)}`
      searchFrom = signatureEnd
    }
    else {
      searchFrom = signatureStart
    }
  }
  return candidate
}

const canonicalizePreparedPair = (
  reviewed: TransactionPlanPrepared,
  candidate: TransactionPlanPrepared,
  placeholderSignatureCalls: readonly ReviewedSignaturePlaceholderCall[],
): [string, string] => {
  const allowedSignatureCalls = new Set(placeholderSignatureCalls.map(signatureCallKey))
  const reviewedPlan = reviewed.plan.map((item) => {
    if (item.type !== 'evcBatch') return item
    return {
      ...item,
      items: item.items.map((entry) => {
        const reviewedCalls = isEVCBatchOperation(entry) ? entry.items : [entry]
        const calls = reviewedCalls.map((call) => {
          const canonical = canonicalizePythUpdate(call)
          if (!allowedSignatureCalls.has(signatureCallKey(call)) || typeof canonical.data !== 'string') return canonical
          return { ...canonical, data: canonicalizeReviewedSignature(canonical.data) }
        })
        return isEVCBatchOperation(entry) ? { ...entry, items: calls } : calls[0]
      }),
    }
  })
  const candidatePlan = candidate.plan.map((item, itemIndex) => {
    if (item.type !== 'evcBatch') return item
    const reviewedItem = reviewed.plan[itemIndex]
    return {
      ...item,
      items: item.items.map((entry, entryIndex) => {
        const candidateCalls = isEVCBatchOperation(entry) ? entry.items : [entry]
        const reviewedEntry = reviewedItem?.type === 'evcBatch' ? reviewedItem.items[entryIndex] : undefined
        const reviewedCalls = reviewedEntry && isEVCBatchOperation(reviewedEntry) ? reviewedEntry.items : reviewedEntry ? [reviewedEntry] : []
        const calls = candidateCalls.map((call, callIndex) => {
          const canonical = canonicalizePythUpdate(call)
          const reviewedCall = reviewedCalls[callIndex] as Record<string, unknown> | undefined
          if (
            !reviewedCall
            || !allowedSignatureCalls.has(signatureCallKey(reviewedCall as ReviewedSignaturePlaceholderCall))
            || typeof canonical.data !== 'string'
            || typeof reviewedCall.data !== 'string'
          ) return canonical
          return { ...canonical, data: canonicalizeMatchingSignature(reviewedCall.data, canonical.data) }
        })
        return isEVCBatchOperation(entry) ? { ...entry, items: calls } : calls[0]
      }),
    }
  })
  const stringify = (prepared: TransactionPlanPrepared, plan: TransactionPlan) => JSON.stringify({
    chainId: prepared.chainId,
    account: (typeof prepared.account === 'string' ? prepared.account : prepared.account.owner).toLowerCase(),
    usePermit2: prepared.usePermit2,
    unlimitedApproval: prepared.unlimitedApproval,
    plan,
  }, (_key, value) => typeof value === 'bigint' ? `${value.toString()}n` : value)
  return [stringify(reviewed, reviewedPlan as TransactionPlan), stringify(candidate, candidatePlan as TransactionPlan)]
}

/**
 * Bind batch execution to the prepared envelope shown in review. Fresh Pyth
 * payloads are allowed, and explicitly reviewed migration placeholder
 * signatures may be replaced at their ABI-encoded bytes slot. Everything else,
 * including approvals, targets, values, and operation calldata, remains exact.
 */
export const requireReviewedBatchPreparedExecution = (
  reviewed: TransactionPlanPrepared,
  candidate: TransactionPlanPrepared,
  options: { placeholderSignatureCalls?: readonly ReviewedSignaturePlaceholderCall[] } = {},
): TransactionPlanPrepared => {
  if (reviewed === candidate) return candidate
  const [reviewedCanonical, candidateCanonical] = canonicalizePreparedPair(
    reviewed,
    candidate,
    options.placeholderSignatureCalls ?? [],
  )
  if (reviewedCanonical !== candidateCanonical) {
    throw new Error(REVIEWED_BATCH_EXECUTION_CHANGED_ERROR)
  }
  return candidate
}

export const hasPreparedPythUpdate = (prepared: TransactionPlanPrepared): boolean =>
  prepared.plan.some(item =>
    item.type === 'evcBatch'
    && flattenBatchEntries(item.items).some(call => isPythUpdate(call)),
  )

const canonicalizeReviewedPlan = (prepared: TransactionPlanPrepared): string => JSON.stringify({
  chainId: prepared.chainId,
  account: (typeof prepared.account === 'string' ? prepared.account : prepared.account.owner).toLowerCase(),
  usePermit2: prepared.usePermit2,
  unlimitedApproval: prepared.unlimitedApproval,
  plan: prepared.plan.map((item) => {
    if (item.type !== 'evcBatch') return item
    return {
      ...item,
      items: item.items.map(entry => isEVCBatchOperation(entry)
        ? { ...entry, items: entry.items.map(call => canonicalizePythUpdate(call)) }
        : canonicalizePythUpdate(entry)),
    }
  }),
}, (_key, value) => typeof value === 'bigint' ? `${value.toString()}n` : value)

/**
 * Permit a just-in-time Pyth payload/fee refresh while requiring every reviewed
 * approval, operation, target and execution option to remain exact.
 */
export const requirePythOnlyPreparedRefresh = (
  reviewed: TransactionPlanPrepared,
  refreshed: TransactionPlanPrepared,
): TransactionPlanPrepared => {
  if (canonicalizeReviewedPlan(reviewed) !== canonicalizeReviewedPlan(refreshed)) {
    throw new Error(REVIEWED_EXECUTION_CHANGED_ERROR)
  }
  return refreshed
}

type PrepareReviewedPlan = (
  plan: TransactionPlan,
  options: Pick<TransactionPlanPrepared, 'account' | 'chainId' | 'usePermit2'>,
) => Promise<TransactionPlanPrepared>

/**
 * Refresh short-lived Pyth payloads at the shared confirmation boundary while
 * pinning preparation to the exact account, chain and Permit2 mode reviewed.
 */
export const refreshReviewedPythExecution = async (
  reviewed: TransactionPlanPrepared,
  rawPlan: TransactionPlan | undefined,
  prepare: PrepareReviewedPlan,
): Promise<TransactionPlanPrepared> => {
  if (!hasPreparedPythUpdate(reviewed)) return reviewed
  if (!rawPlan?.length) throw new Error(REVIEWED_EXECUTION_UNAVAILABLE_ERROR)
  const refreshed = await prepare(rawPlan, {
    account: reviewed.account,
    chainId: reviewed.chainId,
    usePermit2: reviewed.usePermit2,
  })
  return requirePythOnlyPreparedRefresh(reviewed, refreshed)
}

export const requireReviewedExecution = (
  reviewed: TransactionPlanPrepared | undefined,
): TransactionPlanPrepared => {
  if (!reviewed) throw new Error(REVIEWED_EXECUTION_UNAVAILABLE_ERROR)
  return reviewed
}
