import { isEVCBatchOperation, type EVCBatchItem, type TransactionPlan, type TransactionPlanPrepared } from '@eulerxyz/euler-v2-sdk'
import { toFunctionSelector } from 'viem'

export const REVIEWED_BATCH_EXECUTION_CHANGED_ERROR
  = 'The batch changed after review. Close this review and review the final transaction again.'

const PYTH_UPDATE_SELECTOR = toFunctionSelector('function updatePriceFeeds(bytes[])').toLowerCase()
const DYNAMIC_SIGNATURE_LENGTH_WORD = `${'0'.repeat(62)}41`
const PLACEHOLDER_SIGNATURE_DATA = '0'.repeat(65 * 2)
const SIGNATURE_MARKER = '__reviewed_signature__'

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

const canonicalizePythUpdate = (item: Record<string, unknown>): Record<string, unknown> => {
  const data = typeof item.data === 'string' ? item.data : ''
  if (data.slice(0, 10).toLowerCase() !== PYTH_UPDATE_SELECTOR) return item
  return { ...item, data: '__fresh_pyth_update__', value: '__fresh_pyth_fee__' }
}

const canonicalizeReviewedSignatures = (data: string): string => {
  let result = data.toLowerCase()
  let searchFrom = 0
  while (searchFrom < result.length) {
    const lengthWordIndex = result.indexOf(DYNAMIC_SIGNATURE_LENGTH_WORD, searchFrom)
    if (lengthWordIndex < 0) break
    const signatureStart = lengthWordIndex + DYNAMIC_SIGNATURE_LENGTH_WORD.length
    const signatureEnd = signatureStart + PLACEHOLDER_SIGNATURE_DATA.length
    if (result.slice(signatureStart, signatureEnd) === PLACEHOLDER_SIGNATURE_DATA) {
      result = `${result.slice(0, signatureStart)}${SIGNATURE_MARKER}${result.slice(signatureEnd)}`
      searchFrom = signatureStart + SIGNATURE_MARKER.length
    }
    else {
      searchFrom = signatureStart
    }
  }
  return result
}

const canonicalizeCandidateSignatures = (reviewedData: string, candidateData: string): string => {
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
      candidate = `${candidate.slice(0, signatureStart)}${SIGNATURE_MARKER}${candidate.slice(signatureEnd)}`
    }
    searchFrom = signatureEnd
  }
  return candidate
}

const canonicalizePlans = (
  reviewed: TransactionPlanPrepared,
  candidate: TransactionPlanPrepared,
  placeholderSignatureCalls: readonly ReviewedSignaturePlaceholderCall[],
): [TransactionPlan, TransactionPlan] => {
  const allowedSignatureCalls = new Set(placeholderSignatureCalls.map(signatureCallKey))
  const reviewedPlan = reviewed.plan.map((item) => {
    if (item.type !== 'evcBatch') return item
    return {
      ...item,
      items: item.items.map((entry) => {
        const calls = (isEVCBatchOperation(entry) ? entry.items : [entry]).map((call) => {
          const canonical = canonicalizePythUpdate(call)
          if (!allowedSignatureCalls.has(signatureCallKey(call)) || typeof canonical.data !== 'string') return canonical
          return { ...canonical, data: canonicalizeReviewedSignatures(canonical.data) }
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
        const reviewedCalls = reviewedEntry && isEVCBatchOperation(reviewedEntry)
          ? reviewedEntry.items
          : reviewedEntry ? [reviewedEntry] : []
        const calls = candidateCalls.map((call, callIndex) => {
          const canonical = canonicalizePythUpdate(call)
          const reviewedCall = reviewedCalls[callIndex] as Record<string, unknown> | undefined
          if (
            !reviewedCall
            || !allowedSignatureCalls.has(signatureCallKey(reviewedCall as ReviewedSignaturePlaceholderCall))
            || typeof canonical.data !== 'string'
            || typeof reviewedCall.data !== 'string'
          ) return canonical
          return {
            ...canonical,
            data: canonicalizeCandidateSignatures(reviewedCall.data, canonical.data),
          }
        })
        return isEVCBatchOperation(entry) ? { ...entry, items: calls } : calls[0]
      }),
    }
  })

  return [reviewedPlan as TransactionPlan, candidatePlan as TransactionPlan]
}

const stringifyPrepared = (prepared: TransactionPlanPrepared, plan: TransactionPlan) => JSON.stringify({
  chainId: prepared.chainId,
  account: (typeof prepared.account === 'string' ? prepared.account : prepared.account.owner).toLowerCase(),
  usePermit2: prepared.usePermit2,
  unlimitedApproval: prepared.unlimitedApproval,
  plan,
}, (_key, value) => typeof value === 'bigint' ? `${value.toString()}n` : value)

/**
 * Require the final execution envelope to match the prepared review. Only a
 * fresh Pyth payload/fee and explicitly flagged 65-byte migration signature
 * placeholders may differ.
 */
export const requireReviewedBatchPreparedExecution = (
  reviewed: TransactionPlanPrepared,
  candidate: TransactionPlanPrepared,
  options: { placeholderSignatureCalls?: readonly ReviewedSignaturePlaceholderCall[] } = {},
): TransactionPlanPrepared => {
  if (reviewed === candidate) return candidate
  const [reviewedPlan, candidatePlan] = canonicalizePlans(
    reviewed,
    candidate,
    options.placeholderSignatureCalls ?? [],
  )
  if (stringifyPrepared(reviewed, reviewedPlan) !== stringifyPrepared(candidate, candidatePlan)) {
    throw new Error(REVIEWED_BATCH_EXECUTION_CHANGED_ERROR)
  }
  return candidate
}
